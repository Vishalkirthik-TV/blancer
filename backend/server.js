const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // Added CORS
const { generateContractPDF } = require('./pdf_service');
const PDFDocument = require('pdfkit');
const { processProjectConversation, generateProjectSummary } = require('./ai_service');
const { fundEscrow, releaseFunds, raiseDispute } = require('./escrow_service');
const { logEvent, generateProof } = require('./timeline_service');
const { generatePaymentUrl, simulateOffRampPayout, getEscrowReceivingAddress } = require('./transak_service');

dotenv.config();

const app = express();
app.use(cors()); // Enable CORS
app.use(express.json()); // Enable JSON parsing
const bot = new Telegraf(process.env.BOT_TOKEN);

// Simple in-memory state store (replace with Redis/DB for production)
// Simple in-memory state store (replace with Redis/DB for production)
let chatStates = {};
let projectStore = {}; // Store projects by ID
let usernameMap = {}; // Map @username -> chatId

// Persistence File Path
const STATE_FILE = path.join(__dirname, 'bot_state.json');

// LOAD STATE
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            const state = JSON.parse(data);
            chatStates = state.chatStates || {};
            projectStore = state.projectStore || {};
            usernameMap = state.usernameMap || {};
            console.log("✅ State loaded from disk.");
        }
    } catch (e) {
        console.error("Failed to load state:", e);
    }
}

// SAVE STATE
function saveState() {
    try {
        const state = { chatStates, projectStore, usernameMap };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error("Failed to save state:", e);
    }
}

// Load on start
loadState();


const STEPS = {
    IDLE: 'IDLE',
    CAPTURE: 'CAPTURE',
    CONFIRM_CLIENT: 'CONFIRM_CLIENT',
    ASK_FREELANCER: 'ASK_FREELANCER',
    WAITING_FREELANCER: 'WAITING_FREELANCER',
    FUNDING: 'FUNDING',
    SELECT_PAYMENT_METHOD: 'SELECT_PAYMENT_METHOD', // UPI/Bank vs Crypto
    WAITING_TRANSAK: 'WAITING_TRANSAK', // Waiting for Transak payment
    WORKING: 'WORKING',
    SUBMITTING: 'SUBMITTING', // Freelancer uploading work
    WAITING_APPROVAL: 'WAITING_APPROVAL', // Freelancer waiting for client
    CLIENT_REVIEW: 'CLIENT_REVIEW', // Client reviewing work
    CLIENT_REJECTING: 'CLIENT_REJECTING', // Client typing rejection reason
    SELECT_PAYMENT_TYPE: 'SELECT_PAYMENT_TYPE',
    DEFINE_MILESTONES: 'DEFINE_MILESTONES',
    CONFIRM_MILESTONES: 'CONFIRM_MILESTONES',
    SENDING_DM: 'SENDING_DM', // User trying to send a text message
    EDITING_MILESTONES: 'EDITING_MILESTONES',
    WAITING_FOR_MILESTONE_APPROVAL: 'WAITING_FOR_MILESTONE_APPROVAL',
    SELECT_PAYOUT_METHOD: 'SELECT_PAYOUT_METHOD', // Freelancer: Bank vs Crypto
    WAITING_PAYOUT_SELECTION: 'WAITING_PAYOUT_SELECTION', // Client waiting for freelancer
    WAITING_PAYOUT_ADDRESS: 'WAITING_PAYOUT_ADDRESS', // Waiting for crypto address
    CONFIRM_RELEASE: 'CONFIRM_RELEASE' // Client confirming release
};

// Check if state is locked (active project)
const LOCKED_STEPS = [STEPS.WORKING, STEPS.SUBMITTING, STEPS.WAITING_APPROVAL, STEPS.CLIENT_REVIEW, STEPS.CLIENT_REJECTING, STEPS.SENDING_DM, STEPS.EDITING_MILESTONES, STEPS.WAITING_FOR_MILESTONE_APPROVAL];

// HELPER: Send Persistent Menu
function sendPersistentMenu(ctx, role) {
    let buttons = [];
    if (role === 'client') {
        buttons = [
            [Markup.button.callback('📩 Send Message', 'main_menu_dm'), Markup.button.callback('📞 Request Call', 'main_menu_call')],
            [Markup.button.callback('📹 Video Call', 'main_menu_video'), Markup.button.callback('📊 Project Status', 'main_menu_status')],
            [Markup.button.callback('🤖 AI Summary', 'main_menu_ai_summary'), Markup.button.callback('✏️ Edit Milestones', 'main_menu_edit_milestones')]
        ];
    } else {
        buttons = [
            [Markup.button.callback('📩 Send Message', 'main_menu_dm'), Markup.button.callback('📞 Request Call', 'main_menu_call')],
            [Markup.button.callback('📹 Video Call', 'main_menu_video'), Markup.button.callback('📤 Submit Work', 'main_menu_submit')],
            [Markup.button.callback('📊 Project Status', 'main_menu_status'), Markup.button.callback('🤖 AI Summary', 'main_menu_ai_summary')]
        ];
    }

    return ctx.reply("🛠️ *Project Menu*\nSelect an action:", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}


// Middleware to ensure state exists
bot.use((ctx, next) => {
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username;

    if (username && chatId) {
        usernameMap[username.toLowerCase()] = chatId;
        saveState(); // Save mapping
    }

    if (chatId && !chatStates[chatId]) {
        chatStates[chatId] = { step: STEPS.IDLE, project: {}, client: null, freelancer: null, missingField: null, history: [] };
    }
    return next();
});

// START COMMAND - Handle deep links for project invitations
bot.start(async (ctx) => {
    const payload = ctx.startPayload; // Gets the parameter after 'start='

    console.log("\n=== BOT START TRIGGERED ===");
    console.log("User:", ctx.from.username || ctx.from.first_name, "ID:", ctx.from.id);
    console.log("Payload:", payload);

    if (payload && payload.startsWith('project_')) {
        console.log("✓ Detected project invitation");
        // This is a project invitation
        const projectId = parseInt(payload.replace('project_', ''));
        const project = projectStore[projectId];

        if (!project) {
            console.log("ERROR: Project not found!");
            return ctx.reply("❌ Invalid or expired invitation link.");
        }

        if (project.status !== 'pending') {
            return ctx.reply("❌ This invitation has already been processed.");
        }

        // Show invitation to freelancer
        const inviteMessage =
            `👋 You've been invited to a paid project with escrow protection.\n\n` +
            `📌 Scope: ${project.project.scope}\n` +
            `💰 Payment: ₹${project.project.budget} ${project.project.currency} (secured in escrow)\n` +
            `⏳ Timeline: ${project.project.timeline_days} days\n\n` +
            `Do you accept?`;

        // Initialize freelancer state
        const freelancerChatId = ctx.chat.id;
        chatStates[freelancerChatId] = {
            step: STEPS.IDLE, // Will act on button click
            project: {},
            client: null,
            freelancer: ctx.from.id
        };

        await ctx.reply(
            inviteMessage,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ Accept', `accept_${projectId}`)],
                [Markup.button.callback('❌ Decline', `decline_${projectId}`)],
                [Markup.button.callback('💬 Ask question', `question_${projectId}`)]
            ])
        );
    } else {
        console.log("→ Normal /start (Initiating Project)");

        const chatId = ctx.chat.id;
        const state = chatStates[chatId];

        if (state && LOCKED_STEPS.includes(state.step)) {
            const counterparty = state.role === 'client'
                ? (state.freelancerUsername || "your freelancer")
                : (state.clientUsername || "your client");

            return ctx.reply(
                `🚫 *Active Project in Progress*\n\n` +
                `You are currently working with @${counterparty}.\n` +
                `You cannot switch roles or leave the project until it is completed/cancelled.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('➡️ Continue Project', 'resume_session')]
                    ])
                }
            );
        }

        // Check for active session (not IDLE or Locked)
        if (state && state.step !== STEPS.IDLE) {
            return ctx.reply(
                `⚠️ *Active Session Detected*\n\n` +
                `You are currently in *${state.step}* mode.\n` +
                `Do you want to continue or start over?`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('➡️ Continue Session', 'resume_session'),
                        Markup.button.callback('🔄 Start New / Change Role', 'reset_session')]
                    ])
                }
            );
        }

        // Default start: Ask for role
        ctx.reply(
            "👋 Welcome to ZENT Escrow!\n\n" +
            "Are you looking to *HIRE* or *WORK*?",
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('👨‍💼 I am a Client (Hire)', 'role_client')],
                    [Markup.button.callback('👨‍💻 I am a Freelancer (Work)', 'role_freelancer')]
                ])
            }
        );
    }
    console.log("=== END START HANDLER ===\n");
});

// TEXT HANDLER (For Project Capture & Freelancer Username)
bot.on('message', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    // Skip if no active workflow
    if (!state || state.step === STEPS.IDLE) return;

    // Project Capture & Refinement (Agentic Flow)
    if (state.step === STEPS.CAPTURE) {
        if (ctx.from.id !== state.client) return; // Only listen to client

        let text = ctx.message.text || ctx.message.caption || "";

        // Handle attachments
        if (ctx.message.document || ctx.message.photo) {
            if (!state.documents) state.documents = [];

            let fileId;
            let type;
            if (ctx.message.document) {
                fileId = ctx.message.document.file_id;
                type = 'document';
                text += " [Attached a document]";
            } else if (ctx.message.photo) {
                // Get the largest photo
                fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                type = 'photo';
                text += " [Attached a photo]";
            }

            state.documents.push({ type, fileId });
            console.log(`📎 Stored ${type}: ${fileId}`);
        }

        if (!text) return; // Ignore if no content (e.g. sticker without caption, though we listen to 'message')

        // Initialize conversation history if new
        if (!state.history) state.history = [];

        ctx.sendChatAction('typing'); // Show typing indicator

        // call the agent
        try {
            const result = await processProjectConversation(state.history, text);

            if (result.status === 'incomplete') {
                // Update history
                state.history.push({ role: 'user', text: text });
                state.history.push({ role: 'assistant', text: result.reply });

                // Ask the follow-up question
                ctx.reply(result.reply);
            }
            else if (result.status === 'complete') {
                // Capture complete!
                state.project = result.data;
                state.step = STEPS.CONFIRM_CLIENT;
                state.history = null; // Clear history

                const docCount = state.documents ? state.documents.length : 0;
                const infoSummary = state.project.additional_info && state.project.additional_info !== 'None' ? state.project.additional_info : '';

                const summary =
                    `✅ Terms Captured:\n\n` +
                    `📌 Scope: ${state.project.scope}\n` +
                    `💰 Budget: ${state.project.budget} ${state.project.currency}\n` +
                    `⏳ Timeline: ${state.project.timeline_days} days\n` +
                    (infoSummary ? `📝 Extra Info: ${infoSummary}\n` : '') +
                    (docCount > 0 ? `📎 Attachments: ${docCount} file(s)\n` : '') +
                    `\nReady to confirm?`;

                ctx.reply(summary, Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Confirm', 'confirm_project'), Markup.button.callback('✏️ Edit', 'edit_project')]
                ]));
            }
        } catch (error) {
            console.error("Agent error:", error);
            ctx.reply("⚠️ Sorry, I had trouble thinking. Could you specify the budget and timeline directly?");
        }
    }

    // Freelancer Username Input
    else if (state.step === STEPS.ASK_FREELANCER) {
        if (ctx.from.id !== state.client) return;

        const input = ctx.message.text.trim();

        // Extract username or phone - allow @username or username
        let freelancerIdentifier = input.replace('@', '').toLowerCase();

        try {
            // Try to lookup freelancer chatId from memory
            const freelancerChatId = usernameMap[freelancerIdentifier];

            if (!freelancerChatId) {
                // Freelancer hasn't started the bot effectively
                console.log(`Freelancer @${freelancerIdentifier} not found in map.`);
                // Proceed to fallback link logic directly or try catch block
                throw new Error("Freelancer not found in memory");
            }

            const projectId = Date.now(); // Simple ID
            projectStore[projectId] = {
                clientId: state.client,
                clientChatId: chatId,
                project: state.project,
                status: 'pending'
            };
            saveState(); // Save project

            const inviteMessage =
                `👋 You've been invited to a paid project with escrow protection.\n\n` +
                `📌 Scope: ${state.project.scope}\n` +
                `💰 Payment: ₹${state.project.budget} ${state.project.currency} (secured in escrow)\n` +
                `⏳ Timeline: ${state.project.timeline_days} days\n\n` +
                `Do you accept?`;

            ctx.reply(
                `Found @${freelancerIdentifier}!\nSending invitation...`
            );

            // Send to actual chat ID
            bot.telegram.sendMessage(
                freelancerChatId,
                inviteMessage,
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Accept', `accept_${projectId}`)],
                    [Markup.button.callback('❌ Decline', `decline_${projectId}`)],
                    [Markup.button.callback('💬 Ask question', `question_${projectId}`)]
                ])
            ).then(() => {
                state.step = STEPS.WAITING_FREELANCER;
                state.projectId = projectId;
                ctx.reply(`✅ Direct invitation sent to @${freelancerIdentifier}!\n\nWaiting for their response...`);
            }).catch(async (error) => {
                console.error("Failed to send DM:", error.message);
                // Fallback to link if blocked or error
                throw error;
            });

        } catch (error) {
            // Fallback: Generate deep link
            const projectId = Date.now(); // Create ID if not exists or reuse if we failed slightly later
            // Re-create simple project store entry for fallback
            projectStore[projectId] = {
                clientId: state.client,
                clientChatId: chatId,
                project: state.project,
                status: 'pending'
            };
            saveState(); // Save project

            const botUsername = ctx.botInfo.username;
            const inviteLink = `https://t.me/${botUsername}?start=project_${projectId}`;

            state.step = STEPS.WAITING_FREELANCER;
            state.projectId = projectId;

            await ctx.reply(
                `⚠️ Could not send direct message to @${freelancerIdentifier}.\n` +
                `(They might not have started this bot recently)\n\n` +
                `Share this invitation link with them:\n` +
                `👉 ${inviteLink}\n\n` +
                `When they click it, they'll see the project invitation.`
            );
        }
    }

    // Work completion & Persistent Menu Trigger
    else if (state.step === STEPS.WORKING) {
        // If it's a command, let it pass
        if (ctx.message.text && ctx.message.text.startsWith('/')) return;

        // Any other text triggers the menu
        return sendPersistentMenu(ctx, state.role || (state.client === ctx.from.id ? 'client' : 'freelancer'));
    }

    // Sending DM (Forwarding message)
    else if (state.step === STEPS.SENDING_DM) {
        const text = ctx.message.text;
        const targetId = state.role === 'client' ? state.freelancer : state.client;

        if (text && targetId) {
            bot.telegram.sendMessage(targetId, `📩 **Message from ${state.username || "Counterparty"}:**\n\n${text}`);

            // Log message to conversation history
            if (!state.project.conversation) state.project.conversation = [];
            state.project.conversation.push({
                role: state.role,
                username: state.username,
                text: text,
                timestamp: new Date().toISOString()
            });

            // Sync conversation to counterparty state
            if (chatStates[targetId] && chatStates[targetId].project) {
                chatStates[targetId].project.conversation = state.project.conversation;
            }

            ctx.reply("✅ Message Sent!");
        } else {
            ctx.reply("⚠️ Could not send message.");
        }

        state.step = STEPS.WORKING; // Go back to working state
        // Show menu again? Maybe optional to not spam
        return sendPersistentMenu(ctx, state.role);
    }

    // Freelancer Submitting Work (Collecting parts)
    else if (state.step === STEPS.SUBMITTING) {
        if (!state.freelancer || (ctx.from.id != state.freelancer)) return;

        // Collect content
        if (!state.submissionParts) state.submissionParts = [];

        const part = {};
        if (ctx.message.text) {
            part.type = 'text';
            part.content = ctx.message.text;
        } else if (ctx.message.document) {
            part.type = 'document';
            part.fileId = ctx.message.document.file_id;
            part.fileName = ctx.message.document.file_name;
        } else if (ctx.message.photo) {
            part.type = 'photo';
            part.fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        }

        state.submissionParts.push(part);

        ctx.reply(`✅ Received. Send more or click Submit.`,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ Submit Final Work', 'submit_final_work')]
            ]));
    }
    // Client Rejecting (Typing Reason)
    else if (state.step === STEPS.CLIENT_REJECTING) {
        if (ctx.from.id !== state.client) return;

        const reason = ctx.message.text;

        // Notify freelancer
        bot.telegram.sendMessage(
            state.freelancer,
            `❌ **Work Rejected / Changes Requested**\n\n` +
            `**Client Feedback:**\n${reason}\n\n` +
            `Please make changes and submit again.`,
        );

        // Reset Client State
        state.step = STEPS.WORKING; // Client goes back to waiting for freelancer (monitoring)

        // Update freelancer state
        if (state.freelancer && chatStates[state.freelancer]) {
            chatStates[state.freelancer].step = STEPS.WORKING; // Back to working
            chatStates[state.freelancer].submissionParts = []; // Clear previous submission
        }
        saveState(); // Persist state changes for both client and freelancer

        ctx.reply("❌ Feedback sent to freelancer. Waiting for re-submission.");
    }
    // Check if state is locked (active project) (Exclude milestone setup steps from lock for now until funded)
    else if (state.step === STEPS.DEFINE_MILESTONES) {
        if (ctx.from.id !== state.client) return;

        const input = ctx.message.text;
        // Expected format: "Description - Amount"
        // Or "Done"

        if (input.toLowerCase() === 'done') {
            // Validate and confirm
            // (Logic handled in CONFIRM_MILESTONES check or here)
            return;
        }

        const parts = input.split('-').map(s => s.trim());
        if (parts.length < 2) {
            return ctx.reply("❌ Invalid format. Please use: `Description - Amount`\nExample: `Frontend - 5000`");
        }

        const desc = parts[0];
        const amount = parseFloat(parts[1]);

        if (isNaN(amount) || amount <= 0) {
            return ctx.reply("❌ Invalid amount.");
        }

        if (!state.project.milestones) state.project.milestones = [];

        const currentTotal = state.project.milestones.reduce((sum, m) => sum + m.amount, 0);
        const remaining = state.project.budget - currentTotal;

        if (amount > remaining) {
            return ctx.reply(`❌ Amount exceeds remaining budget. Remaining: ${remaining} ${state.project.currency}`);
        }

        state.project.milestones.push({ description: desc, amount: amount, status: 'pending' });

        const newTotal = currentTotal + amount;
        const newRemaining = state.project.budget - newTotal;

        if (newRemaining === 0) {
            state.step = STEPS.IDLE; // Wait for confirmation action
            // Show confirmation
            let msg = "✅ **Milestones Defined:**\n\n";
            state.project.milestones.forEach((m, i) => {
                msg += `${i + 1}. ${m.description}: ${m.amount}\n`;
            });
            msg += `\n**Total:** ${newTotal}\n`;

            ctx.reply(msg, Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirm & Fund', 'confirm_milestones')],
                [Markup.button.callback('🔄 Reset Milestones', 'reset_milestones')]
            ]));
        } else {
            ctx.reply(`✅ Added: ${desc} (${amount})\nRemaining Budget: ${newRemaining}\n\nAdd next milestone:`);
        }
    }
    // EDITING MILESTONES (Active Project)
    else if (state.step === STEPS.EDITING_MILESTONES) {
        if (ctx.from.id !== state.client) return;
        const input = ctx.message.text;

        // If cancellation requested
        if (input.toLowerCase() === '/cancel') {
            state.step = STEPS.WORKING;
            state.newMilestones = [];
            return ctx.reply("❌ Edit Cancelled.");
        }

        const parts = input.split('-').map(s => s.trim());
        if (parts.length < 2) return ctx.reply("Format: `Description - Amount`");

        const desc = parts[0];
        const amount = parseFloat(parts[1]);

        if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Invalid Amount");

        if (!state.newMilestones) state.newMilestones = [];

        const currentTotal = state.newMilestones.reduce((s, m) => s + m.amount, 0);
        const remaining = state.project.budget - currentTotal;

        if (amount > remaining) return ctx.reply(`❌ Amount exceeds budget. Remaining: ${remaining}`);

        state.newMilestones.push({ description: desc, amount: amount, status: 'pending' });

        const newTotal = currentTotal + amount;
        const newRemaining = state.project.budget - newTotal;

        if (newRemaining === 0) {
            state.step = STEPS.IDLE; // Wait for send action

            let msg = "📝 **Proposed New Milestones:**\n\n";
            state.newMilestones.forEach((m, i) => {
                msg += `${i + 1}. ${m.description}: ${m.amount}\n`;
            });
            msg += `\n**Total:** ${newTotal}\n`;

            ctx.reply(msg, Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Send for Approval', 'send_milestones_approval')],
                [Markup.button.callback('🔄 Reset', 'main_menu_edit_milestones')]
            ]));
        } else {
            ctx.reply(`✅ Added: ${desc} (${amount})\nRemaining: ${newRemaining}`);
        }
    }
    // WAITING FOR CRYPTO ADDRESS
    else if (state.step === STEPS.WAITING_PAYOUT_ADDRESS) {
        if (ctx.from.id !== state.freelancer) return;

        const address = ctx.message.text.trim();

        // Basic validation for EVM address
        if (!address.startsWith('0x') || address.length !== 42) {
            return ctx.reply("❌ Invalid address format. Please send a valid Monad/EVM address (starts with 0x...).");
        }

        state.payoutAddress = address;

        ctx.reply(`✅ Address Captured: \`${address}\`\n\nWaiting for client confirmation...`, { parse_mode: 'Markdown' });

        // Notify Client
        if (state.client) {
            bot.telegram.sendMessage(
                state.client,
                `ℹ️ *Freelancer chose Crypto Payout*\n\n` +
                `Wallet: \`${address}\`\n\n` +
                `Please confirm the release.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Confirm Release', 'confirm_release')]
                    ])
                }
            );
            if (chatStates[state.client]) chatStates[state.client].step = STEPS.CONFIRM_RELEASE;
        }
    }
});

// ACTIONS

// Client confirms project
bot.action('confirm_project', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client can confirm.");

    state.step = STEPS.ASK_FREELANCER;

    // Log project creation
    const projectId = Date.now(); // Temporary ID to track creation before assignment
    chatStates[chatId].tempProjectId = projectId; // Store for later
    logEvent(projectId.toString(), 'PROJECT_DEFINED', state.project, ctx.from.id);

    ctx.editMessageText(
        `✅ Project Confirmed!\n\n` +
        `Now, please share the freelancer's Telegram username.\n` +
        `Example: @john_dev`
    );
    ctx.answerCbQuery();
});

// Edit project (reset to capture)
bot.action('edit_project', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client can edit.");

    state.step = STEPS.CAPTURE;
    state.history = []; // Reset history
    ctx.reply("Okay, please describe the project again.");
    ctx.answerCbQuery();
});

// Freelancer accepts (in their DM)
bot.action(/accept_(\d+)/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    const project = projectStore[projectId];

    if (!project) return ctx.answerCbQuery("Project not found.");
    if (project.status !== 'pending') return ctx.answerCbQuery("Project already processed.");

    project.status = 'accepted';
    project.freelancerId = ctx.from.id;

    // Log Acceptance
    logEvent(projectId.toString(), 'FREELANCER_ACCEPTED', { freelancerId: ctx.from.id }, ctx.from.id);

    const freelancerChatId = ctx.chat.id;
    const freelancerUsername = ctx.from.username || ctx.from.first_name;

    // Update Client State with Freelancer Info
    const clientState = chatStates[project.clientId]; // Assuming Client ID is Chat ID
    if (clientState) {
        clientState.freelancer = ctx.from.id;
        clientState.freelancerUsername = freelancerUsername;
        clientState.step = STEPS.SELECT_PAYMENT_TYPE; // Goto payment selection
        clientState.projectId = projectId;
        clientState.role = 'client';
    }

    // Set Freelancer State
    const clientUsername = clientState ? (clientState.username || "Client") : "Client"; // We might not have client username unless stored earlier.

    chatStates[freelancerChatId] = {
        step: STEPS.IDLE, // Waiting for funding
        client: project.clientId,
        clientUsername: clientUsername,
        freelancer: ctx.from.id,
        freelancerUsername: freelancerUsername,
        project: project.project,
        projectId: projectId,
        role: 'freelancer'
    };
    saveState(); // Save acceptance

    // Notify freelancer
    ctx.editMessageText(
        `✅ You accepted the project!\n\n` +
        `Waiting for client to set up payment...`
    );

    // Notify client
    bot.telegram.sendMessage(
        project.clientId,
        `🎉 Freelancer @${ctx.from.username || ctx.from.first_name} has accepted the project!\n\n` +
        `How would you like to pay?`,
        Markup.inlineKeyboard([
            [Markup.button.callback(`💰 One-Time Payment (₹${project.project.budget})`, `payment_type_onetime`)],
            [Markup.button.callback(`📅 Milestone Payments`, `payment_type_milestone`)]
        ])
    );

    ctx.answerCbQuery("Accepted!");
});

// Freelancer declines
bot.action(/decline_(\d+)/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    const project = projectStore[projectId];

    if (!project) return ctx.answerCbQuery("Project not found.");

    project.status = 'declined';

    ctx.editMessageText("❌ You declined the project.");

    // Notify client
    bot.telegram.sendMessage(
        project.clientId,
        `❌ Freelancer declined the project.`
    );

    ctx.answerCbQuery("Declined");
});

// PAYMENT TYPE HANDLERS
bot.action('payment_type_onetime', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    state.project.paymentType = 'onetime';
    state.step = STEPS.SELECT_PAYMENT_METHOD;

    ctx.editMessageText(
        `✅ One-Time Payment selected.\n\n` +
        `💰 Amount: ₹${state.project.budget}\n\n` +
        `How would you like to pay?`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💳 Pay via UPI / Bank', 'pay_method_upi')],
            [Markup.button.callback('🔗 Pay via Crypto Wallet', 'pay_method_crypto')]
        ])
    );
});

bot.action('payment_type_milestone', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    state.project.paymentType = 'milestone';
    state.project.milestones = [];
    state.step = STEPS.DEFINE_MILESTONES;

    ctx.editMessageText(
        `📅 **Define Milestones**\n\n` +
        `Total Budget: ${state.project.budget} ${state.project.currency}\n\n` +
        `Please add milestones in this format:\n` +
        `\`Description - Amount\`\n\n` +
        `Example: \`Initial Design - 5000\``
    );
});

bot.action('confirm_milestones', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    state.step = STEPS.FUNDING; // Ready to fund

    ctx.editMessageText(
        `✅ Milestones Confirmed.\n` +
        `Please fund the total amount to activate them.`,
        Markup.inlineKeyboard([
            [Markup.button.callback(`💸 Fund Total ₹${state.project.budget}`, 'fund_escrow')]
        ])
    );
});

bot.action('reset_milestones', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    state.project.milestones = [];
    state.step = STEPS.DEFINE_MILESTONES;
    ctx.editMessageText("🔄 Milestones reset. Please start adding them again (Description - Amount).");
});

// PAYMENT METHOD HANDLERS (Transak Integration)

// UPI / Bank payment via Transak
bot.action('pay_method_upi', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    state.step = STEPS.WAITING_TRANSAK;
    state.paymentMethod = 'upi';
    saveState();

    const escrowWallet = getEscrowReceivingAddress();
    const orderId = `ESC_${state.projectId}_${Date.now()}`;
    state.transakOrderId = orderId;

    // Generate Transak widget URL
    const paymentUrl = generatePaymentUrl(
        state.project.budget,
        escrowWallet,
        orderId
    );

    await ctx.editMessageText(
        `💳 **Pay via UPI / Bank**\n\n` +
        `Amount: ₹${state.project.budget}\n` +
        `Order ID: \`${orderId}\`\n\n` +
        `Tap below to complete payment securely via Transak.\n` +
        `_(Sandbox mode: Payment is simulated)_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🔐 Pay Now (In-App)', paymentUrl)],
                [Markup.button.callback('✅ I Completed Payment', 'transak_payment_done')],
                [Markup.button.callback('❌ Cancel', 'cancel_payment')]
            ])
        }
    );

    ctx.answerCbQuery();
});

// Direct crypto payment (uses existing escrow flow)
bot.action('pay_method_crypto', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    state.step = STEPS.FUNDING;
    state.paymentMethod = 'crypto';
    saveState();

    ctx.editMessageText(
        `🔗 **Pay via Crypto Wallet**\n\n` +
        `Amount: ₹${state.project.budget} (in MON equivalent)\n\n` +
        `Funds will be locked in escrow on Monad blockchain.`,
        Markup.inlineKeyboard([
            [Markup.button.callback(`💸 Fund Escrow`, 'fund_escrow')]
        ])
    );

    ctx.answerCbQuery();
});

// Transak payment confirmation (sandbox simulation)
bot.action('transak_payment_done', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    ctx.reply("⏳ Verifying payment...");
    ctx.answerCbQuery();

    // In production: verify with Transak API
    // For sandbox: simulate success and fund escrow with testnet wallet

    // Mirror the real flow by funding escrow on Monad
    try {
        const result = await fundEscrow(
            state.project.budget,
            state.freelancer,
            state.project,
            state.client,
            state.freelancer
        );

        if (result.success) {
            state.step = STEPS.WORKING;
            state.escrowId = result.escrowId;
            state.agreementHash = result.agreementHash;
            state.paymentVerified = true;

            logEvent(state.projectId.toString(), 'ESCROW_FUNDED', {
                amount: state.project.budget,
                paymentMethod: 'upi_transak',
                transakOrderId: state.transakOrderId,
                hash: result.hash,
                agreementHash: result.agreementHash,
                onChain: !result.mock
            }, state.client);
            saveState();

            // Notify client
            await ctx.reply(
                `✅ **Payment Verified!**\n\n` +
                `₹${state.project.budget} has been funded to escrow.\n` +
                `Transaction: \`${result.hash?.substring(0, 20)}...\`\n\n` +
                `The freelancer has been notified to start work.`,
                { parse_mode: 'Markdown' }
            );

            // Update freelancer state
            if (state.freelancer && chatStates[state.freelancer]) {
                chatStates[state.freelancer].step = STEPS.WORKING;
                chatStates[state.freelancer].escrowId = result.escrowId;
                chatStates[state.freelancer].project = state.project;
            }

            // Notify freelancer
            bot.telegram.sendMessage(
                state.freelancer,
                `🚀 **Project Started!**\n\n` +
                `Client has funded ₹${state.project.budget} via UPI/Bank.\n` +
                `Funds are secured in escrow.\n\n` +
                `You can start working now!`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.reply("❌ Payment verification failed. Please try again.");
        }
    } catch (error) {
        console.error("Transak mirror fund error:", error);
        ctx.reply("❌ Error processing payment. Please try again.");
    }
});

// Cancel payment
bot.action('cancel_payment', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    state.step = STEPS.SELECT_PAYMENT_TYPE;
    ctx.editMessageText("❌ Payment cancelled. Would you like to try again?");
    ctx.answerCbQuery();
});

// Fund Escrow (Updated)
bot.action('fund_escrow', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client can fund.");

    const isMilestone = state.project.paymentType === 'milestone';

    ctx.reply("Processing mock payment...");
    ctx.answerCbQuery();

    // Check milestones sum checks out if milestone
    if (isMilestone) {
        const sum = state.project.milestones.reduce((a, b) => a + b.amount, 0);
        if (sum !== state.project.budget) {
            return ctx.reply(`❌ Milestones sum (${sum}) does not match budget (${state.project.budget}). Resetting milestones.`);
            // reset logic could go here
        }
    }

    try {
        const result = await fundEscrow(
            state.project.budget,
            state.freelancer,
            state.project,  // Pass project data for hashing
            state.client,   // Client ID
            state.freelancer // Freelancer ID
        );
        if (result.success) {
            state.step = STEPS.WORKING;
            state.escrowId = result.escrowId;
            state.agreementHash = result.agreementHash; // Store hash reference

            // Log Funding with hash info
            logEvent(state.projectId.toString(), 'ESCROW_FUNDED', {
                amount: state.project.budget,
                hash: result.hash,
                agreementHash: result.agreementHash,
                onChain: !result.mock
            }, state.client);
            saveState();

            // Notify client
            const clientMsg =
                `🔒 Escrow Funded Successfully!\n\n` +
                `You have funded ₹${state.project.budget}.\n` +
                (isMilestone ? `Structure: ${state.project.milestones.length} Milestones.\n` : `Structure: One-Time Payment.\n`) +
                `The freelancer has been notified.`;
            ctx.reply(clientMsg);

            if (state.freelancer) {
                if (!chatStates[state.freelancer]) chatStates[state.freelancer] = {};
                chatStates[state.freelancer].step = STEPS.WORKING;
                chatStates[state.freelancer].projectId = state.projectId;
                chatStates[state.freelancer].client = state.client;
                chatStates[state.freelancer].freelancer = state.freelancer;
                chatStates[state.freelancer].escrowId = result.escrowId;

                // Copy milestones to freelancer state so they can see them?
                chatStates[state.freelancer].project = state.project;
            }

            // Notify freelancer
            let milestoneText = "";
            if (isMilestone) {
                state.project.milestones.forEach((m, i) => milestoneText += `${i + 1}. ${m.description} (₹${m.amount})\n`);
            }

            const freelancerMsg =
                `🚀 *Project Started!*\n\n` +
                `Client funded ₹${state.project.budget}.\n` +
                (isMilestone ? `*Milestones:*\n${milestoneText}\n` : `*One-Time Payment*\n`) +
                `You can start working.`;
            bot.telegram.sendMessage(state.freelancer, freelancerMsg, { parse_mode: 'Markdown' });
        } else {
            ctx.reply("Funding failed.");
        }
    } catch (e) {
        console.error(e);
        ctx.reply("Error funding escrow.");
    }
});

// Approve & Release (Updated for Milestones)
bot.action('approve_work', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client can approve.");

    const isMilestone = state.project.paymentType === 'milestone';
    let releaseAmount = null;
    let distinctMilestone = null;

    // START NEW FLOW: Ask Freelancer for Payout Method
    state.step = STEPS.WAITING_PAYOUT_SELECTION;

    // Determine release amount (Full or Milestone)
    releaseAmount = isMilestone
        ? state.project.milestones.find(m => m.status === 'pending')?.amount
        : state.project.budget;

    if (!releaseAmount) return ctx.reply("⚠️ No pending amount found to release.");

    // Store context for release
    state.pendingReleaseAmount = releaseAmount;

    ctx.editMessageText(
        `✅ *Work Approved!*\n\n` +
        `We are now waiting for the freelancer to choose their payout method (INR or Crypto).\n` +
        `You will be asked to confirm the final release shortly.`,
        { parse_mode: 'Markdown' }
    );

    // Notify Freelancer
    if (state.freelancer) {
        // Update freelancer state
        if (chatStates[state.freelancer]) {
            chatStates[state.freelancer].step = STEPS.SELECT_PAYOUT_METHOD;
            chatStates[state.freelancer].pendingReleaseAmount = releaseAmount;
        }

        bot.telegram.sendMessage(
            state.freelancer,
            `🎉 *Work Approved!*\n\n` +
            `The client has approved the work. Funds (₹${releaseAmount}) are ready to be released.\n\n` +
            `How would you like to receive the payment?`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🇮🇳 Receive in Local Currency (INR)', 'payout_method_inr')],
                    [Markup.button.callback('🔗 Receive in Crypto (Monad)', 'payout_method_crypto')]
                ])
            }
        );
    }
});

// FREELANCER: Choose INR
bot.action('payout_method_inr', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.freelancer) return ctx.answerCbQuery("Only freelancer action.");

    state.payoutMethod = 'inr';
    // Mock Off-Ramp Address (could be platform wallet)
    state.payoutAddress = "0x000000000000000000000000000000000000dead"; // Valid mock address

    ctx.editMessageText(
        `✅ You selected *Local Currency (INR)*.\n\n` +
        `The client has been notified to confirm the release.\n` +
        `Funds will be converted and transferred to your bank account.`,
        { parse_mode: 'Markdown' }
    );

    // Notify Client to Confirm
    if (state.client) {
        bot.telegram.sendMessage(
            state.client,
            `ℹ️ *Freelancer chose INR Payout*\n\n` +
            `They have selected to receive funds in their local currency via *Transak Off-Ramp*.\n` +
            `The funds will be sent to the Off-Ramp smart contract to process the fiat conversion.\n\n` +
            `Please confirm the release.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Confirm Release (Transak Off-Ramp)', 'confirm_release')]
                ])
            }
        );
        if (chatStates[state.client]) chatStates[state.client].step = STEPS.CONFIRM_RELEASE;
    }
});

// FREELANCER: Choose Crypto
bot.action('payout_method_crypto', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.freelancer) return ctx.answerCbQuery("Only freelancer action.");

    state.payoutMethod = 'crypto';
    state.step = STEPS.WAITING_PAYOUT_ADDRESS;

    ctx.editMessageText(
        `🔗 *You selected Crypto (Monad)*\n\n` +
        `Please reply with your *Monad Wallet Address* (starts with 0x...).`,
        { parse_mode: 'Markdown' }
    );
});

// CLIENT: Confirm Release
bot.action('confirm_release', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client action.");

    const isMilestone = state.project.paymentType === 'milestone';

    // Get Recipient Address (from partner state or stored on self if synced)
    // We assume we synced it or can get it from freelancer state
    let recipient = null;
    let payoutMethod = 'crypto';

    if (chatStates[state.freelancer]) {
        recipient = chatStates[state.freelancer].payoutAddress;
        payoutMethod = chatStates[state.freelancer].payoutMethod;
    }

    if (!recipient) return ctx.reply("❌ Error: Payout address not found.");

    let releaseAmount = state.pendingReleaseAmount || state.project.budget;

    try {
        await ctx.editMessageText(`💸 Releasing funds to ${payoutMethod === 'inr' ? 'Off-Ramp' : 'Freelancer'}...`);
    } catch (e) {
        // Ignore "message is not modified" error (happens on double clicks)
        if (!e.description?.includes("message is not modified")) {
            console.error("Edit message error:", e);
        }
    }

    try {
        const result = await releaseFunds(state.escrowId, recipient);

        if (result.success) {
            logEvent(state.projectId.toString(), 'PAYMENT_RELEASED', { amount: releaseAmount, hash: result.hash, recipient, method: payoutMethod }, state.client);

            // Success Messages
            let clientMsg = "";
            let freelancerMsg = "";

            if (payoutMethod === 'inr') {
                clientMsg = `✅ *Payment Released via Transak*\nFunds sent to Off-Ramp for INR conversion.\nRef: \`${result.hash?.substring(0, 10)}...\`\n\nThe freelancer will receive the fiat amount shortly.`;
                freelancerMsg = `✅ *Payment Released!*\nClient has released the funds to *Transak Off-Ramp*.\nYour INR transfer is being processed.\nRef: \`${result.hash?.substring(0, 10)}...\``;
            } else {
                clientMsg = `✅ *Payment Complete (Crypto)*\nFunds released directly to freelancer's wallet.\nAddress: \`${recipient}\`\n\nTx: \`${result.hash?.substring(0, 10)}...\``;
                freelancerMsg = `✅ *Payment Received!*\n${releaseAmount} MON has been sent directly to your wallet.\n\nTx: \`${result.hash?.substring(0, 10)}...\``;
            }

            // Milestone Updates
            if (isMilestone) {
                const distinctMilestone = state.project.milestones.find(m => m.status === 'pending');
                if (distinctMilestone) distinctMilestone.status = 'paid';

                // Add next milestone info? (Simplified for brevity)
            }

            // Reset States
            state.step = STEPS.IDLE;
            if (state.freelancer && chatStates[state.freelancer]) {
                chatStates[state.freelancer].step = STEPS.IDLE;
            }

            // Send Messages
            ctx.reply(clientMsg, { parse_mode: 'Markdown' });
            bot.telegram.sendMessage(state.freelancer, freelancerMsg, { parse_mode: 'Markdown' });

        } else {
            ctx.reply(`❌ Release failed: ${result.error}`);
        }
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Error processing release.");
    }
});

// SUBMIT FINAL WORK
bot.action('submit_final_work', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.freelancer) return ctx.answerCbQuery("Only freelancer can submit.");

    if (ctx.from.id !== state.freelancer) return ctx.answerCbQuery("Only freelancer can submit.");

    state.step = STEPS.WAITING_APPROVAL; // Freelancer waits now

    // Log submission
    logEvent(state.projectId.toString(), 'WORK_SUBMITTED', { parts: state.submissionParts.length }, state.freelancer);

    ctx.editMessageText("✅ Work submitted! Waiting for client approval...");

    // Notify Client
    // Combine text parts
    let fullText = state.submissionParts.filter(p => p.type === 'text').map(p => p.content).join('\n\n');
    if (!fullText) fullText = "No text description provided.";

    const clientMsg =
        `ℹ️ **Freelancer has submitted work!**\n\n` +
        `📝 **Description:**\n${fullText}\n\n` +
        `📎 **Attachments:** ${state.submissionParts.filter(p => p.type !== 'text').length} files.\n\n` +
        `Please review the files (sent separately) and then decide.`;

    await bot.telegram.sendMessage(state.client, clientMsg);

    // Send files to client
    for (const part of state.submissionParts) {
        if (part.type === 'document') {
            await bot.telegram.sendDocument(state.client, part.fileId);
        } else if (part.type === 'photo') {
            await bot.telegram.sendPhoto(state.client, part.fileId);
        }
    }

    saveState(); // Save submission state
    await bot.telegram.sendMessage(
        state.client,
        "👉 **Action Required: Approve or Reject?**",
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve & Release Funds', 'approve_work')],
            [Markup.button.callback('❌ Request Changes', 'reject_work')]
        ])
    );

    // Set client state to review (though not strictly needed if we just use buttons, but good for context)
    // We need to find client chat ID.
    // For now, we assume client state exists if they are online, or we just rely on callback.
    // Better to update client state if we can find it.
    // Set client state to review
    // Fix: Use state.client (ID) directly as key if ID == ChatID
    if (chatStates[state.client]) {
        chatStates[state.client].step = STEPS.CLIENT_REVIEW;
        chatStates[state.client].submissionParts = state.submissionParts; // Copy for review context if needed
    }

    ctx.answerCbQuery();
});

// REJECT WORK (Request Changes)
bot.action('reject_work', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (ctx.from.id !== state.client) return ctx.answerCbQuery("Only client can reject.");

    state.step = STEPS.CLIENT_REJECTING;

    ctx.reply(
        "❌ **Requesting Changes**\n\n" +
        "Please type the reason for rejection / what changes are needed.\n" +
        "This will be sent to the freelancer."
    );
    ctx.answerCbQuery();
});


// ERROR HANDLING
bot.catch((err, ctx) => {
    console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
    // Don't crash, just log it.
});

// Resume Session
bot.action('resume_session', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (!state) return ctx.reply("Session expired. Please /start again.");

    ctx.reply("✅ Resuming session in " + state.step + " mode.");
    ctx.answerCbQuery();
});

// Reset Session / Change Role
bot.action('reset_session', (ctx) => {
    const chatId = ctx.chat.id;
    // Reset state to IDLE
    chatStates[chatId] = { step: STEPS.IDLE, project: {}, client: null, freelancer: null, missingField: null, history: [] };
    saveState();

    // Default reply for reset
    ctx.editMessageText(
        "🔄 Session Reset.\n\n" +
        "Are you looking to *HIRE* or *WORK*?",
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('👨‍💼 I am a Client (Hire)', 'role_client')],
                [Markup.button.callback('👨‍💻 I am a Freelancer (Work)', 'role_freelancer')]
            ])
        }
    );
    ctx.answerCbQuery();
});

// Role: Client (Start Capture)
bot.action('role_client', (ctx) => {
    const chatId = ctx.chat.id;

    const username = ctx.from.username || ctx.from.first_name;
    chatStates[chatId] = { step: STEPS.CAPTURE, project: {}, client: ctx.from.id, freelancer: null, missingField: null, history: [], role: 'client', username: username };

    ctx.editMessageText(
        "👨‍💼 *Client Mode Activated*\n\n" +
        "I'm your Escrow Agent. I will help secure your transaction.\n\n" +
        "Please describe your project (Scope, Budget, Deadline):",
        { parse_mode: 'Markdown' }
    );
    ctx.answerCbQuery();
});

// Role: Freelancer (Instructions)
bot.action('role_freelancer', (ctx) => {
    const chatId = ctx.chat.id;
    const username = ctx.from.username || "no_username";

    // Set to IDLE but maybe log they are a freelancer
    chatStates[chatId] = { step: STEPS.IDLE, project: {}, client: null, freelancer: ctx.from.id, missingField: null, history: [] };

    ctx.editMessageText(
        "👨‍💻 *Freelancer Mode Activated*\n\n" +
        "Create a profile? Not yet. Just wait!\n\n" +
        "1. Share your username (@" + username + ") with a client.\n" +
        "2. Wait for them to send you an invitation via this bot.\n" +
        "3. You will receive a notification here to accept the project.",
        { parse_mode: 'Markdown' }
    );
    ctx.answerCbQuery();
});

// MAIN MENU HANDLERS

bot.action('main_menu_dm', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    state.step = STEPS.SENDING_DM;
    ctx.reply("✍️ Type your message below:");
    ctx.answerCbQuery();
});

bot.action('main_menu_call', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    const targetId = state.role === 'client' ? state.freelancer : state.client;

    bot.telegram.sendMessage(targetId, `📞 *Incoming Call Request*\n\n@${state.username} is requesting a call.`, { parse_mode: 'Markdown' });
    ctx.reply("✅ Call Request Sent!");
    ctx.answerCbQuery();
});

bot.action('main_menu_video', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    const targetId = state.role === 'client' ? state.freelancer : state.client;

    bot.telegram.sendMessage(targetId, `📹 *Video Call Request*\n\n@${state.username} wants to schedule a video call.`, { parse_mode: 'Markdown' });
    ctx.reply("✅ Video Call Request Sent!");
    ctx.answerCbQuery();
});

bot.action('main_menu_status', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    let msg = `📊 **Project Status**\n\n`;
    msg += `📌 Scope: ${state.project.scope}\n`;
    msg += `💰 Budget: ₹${state.project.budget}\n`;

    if (state.project.milestones) {
        msg += `\n*Milestones:*\n`;
        state.project.milestones.forEach((m, i) => {
            msg += `${i + 1}. ${m.description} - ${m.amount} (${m.status === 'paid' ? '✅ Paid' : '⏳ Pending'})\n`;
        });
    }

    ctx.reply(msg, { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});

bot.action('main_menu_download_contract', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    if (!state.project || !state.client) {
        return ctx.answerCbQuery("No active contract found.");
    }

    ctx.reply("📜 Generating contract PDF... Please wait.");
    ctx.answerCbQuery();

    try {
        const parties = {
            clientId: state.client,
            clientUsername: state.clientUsername || state.usernameMap?.[state.client] || 'Client',
            freelancerId: state.freelancer,
            freelancerUsername: state.freelancerUsername || state.username
        };

        const blockchain = {
            escrowId: state.escrowId,
            contractAddress: process.env.CONTRACT_ADDRESS,
            agreementHash: state.agreementHash,
            // Try to find funding tx hash from timeline logs or just leave generic if not easily available
            // In a real app we'd query the events or store txHash in state.
            // For now, we'll check if we have it in state
            txHash: state.fundingTxHash
        };

        const pdfBuffer = await generateContractPDF(state.project, parties, blockchain);

        await ctx.replyWithDocument({
            source: pdfBuffer,
            filename: `Contract_${state.projectId}.pdf`
        }, {
            caption: "📜 **Here is your Smart Contract Agreement**\n\nVerified on Monad Testnet.",
            parse_mode: 'Markdown'
        });

    } catch (e) {
        console.error("PDF Generation Error:", e);
        ctx.reply("❌ Failed to generate contract PDF.");
    }
});

bot.action('main_menu_ai_summary', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    ctx.reply("🤖 Analyzing project status and history... (This may take a few seconds)");
    ctx.answerCbQuery();

    // Generate Summary
    const summary = await generateProjectSummary(state.project, state.project.conversation);

    ctx.reply(`🤖 *AI Project Summary*\n\n${summary}`, { parse_mode: 'Markdown' });
});

bot.action('main_menu_edit_milestones', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (state.role !== 'client') return ctx.answerCbQuery("Only client can edit milestones.");

    state.step = STEPS.EDITING_MILESTONES;
    state.newMilestones = [];

    ctx.reply(
        "✏️ *Edit Milestones*\n\n" +
        "You are redefining the milestones. The TOTAL budget must remain the same.\n" +
        `Target Total: ${state.project.budget}\n\n` +
        "Please enter the first milestone:\n`Description - Amount`\n\n" +
        "Type /cancel to stop editing.",
        { parse_mode: 'Markdown' }
    );
    ctx.answerCbQuery();
});

bot.action('send_milestones_approval', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    state.step = STEPS.WAITING_FOR_MILESTONE_APPROVAL;

    // Notify Freelancer
    if (state.freelancer) {
        let msg = "⚠️ *Client Proposed Milestone Changes*\n\nPlease review the new structure:\n\n";
        state.newMilestones.forEach((m, i) => {
            msg += `${i + 1}. ${m.description}: ${m.amount}\n`;
        });

        // Temporarily store proposed milestones in freelancer state too if needed, 
        // or just rely on client state access via project ID if we had shared DB, 
        // here we can just attach it to the freelancer state object temporarily
        if (chatStates[state.freelancer]) {
            chatStates[state.freelancer].proposedMilestones = state.newMilestones;
        }

        bot.telegram.sendMessage(state.freelancer, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Approve Changes', 'approve_milestones_edit')],
                [Markup.button.callback('❌ Reject Changes', 'reject_milestones_edit')]
            ])
        });
    }

    ctx.editMessageText("⏳ Sent to freelancer for approval.");
});

bot.action('approve_milestones_edit', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    if (!state.proposedMilestones) return ctx.answerCbQuery("No proposed changes found.");

    // Apply Changes
    state.project.milestones = state.proposedMilestones;
    state.proposedMilestones = null;

    // Update Client too
    if (state.client && chatStates[state.client]) {
        chatStates[state.client].project.milestones = state.project.milestones;
        chatStates[state.client].step = STEPS.WORKING;
        chatStates[state.client].newMilestones = null;

        bot.telegram.sendMessage(state.client, "✅ Freelancer APPROVED the milestone changes!");
    }

    // Convert any 'paid' status from old milestones? 
    // Complexity: If we redefine, we assume all are pending or we must account for paid amount.
    // For MVP/Proto: Assume re-definition resets status to pending unless we track paid amount matches.
    // Simplification: Mark all as pending for now, assuming this is done early or handles unpaid only.
    // BETTER: User should only be able to edit UNPAID amount. 
    // BUT for now, let's just apply new milestones.

    logEvent(state.projectId.toString(), 'MILESTONES_UPDATED', { milestones: state.project.milestones }, ctx.from.id);

    state.step = STEPS.WORKING;
    ctx.editMessageText("✅ Milestones Updated.");
});

bot.action('reject_milestones_edit', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];

    state.proposedMilestones = null;
    state.step = STEPS.WORKING;

    if (state.client && chatStates[state.client]) {
        chatStates[state.client].step = STEPS.WORKING;
        chatStates[state.client].newMilestones = null;
        bot.telegram.sendMessage(state.client, "❌ Freelancer REJECTED the milestone changes.");
    }

    ctx.editMessageText("❌ Changes Rejected. Reverted to original.");
});

bot.action('main_menu_submit', (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates[chatId];
    if (state.role !== 'freelancer') return ctx.answerCbQuery("Only freelancer can submit.");

    state.step = STEPS.SUBMITTING;
    state.submissionParts = [];

    ctx.reply(
        "📝 *Submission Started*\n\n" +
        "Please upload your work files (Documents, Photos, Zip) and type a description.\n" +
        "You can send multiple messages.\n\n" +
        "Click *Submit Final Work* when you are done.",
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Submit Final Work', 'submit_final_work')]
            ])
        }
    );
    ctx.answerCbQuery();
});

// Start Bot
bot.launch().then(() => {
    console.log('Bot is running...');
}).catch(err => {
    console.error("Bot launch failed (likely conflict):", err.message);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Optional Express server
// --- API ENDPOINTS FOR WEB PLATFORM ---

// Login (Simple Username Check)
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    console.log("Login attempt:", username);
    if (!username) return res.status(400).json({ error: "Username required" });

    const cleanUsername = username.replace('@', '').toLowerCase().trim(); // Added trim just in case
    console.log("Clean username:", cleanUsername);
    console.log("Map check:", usernameMap[cleanUsername]);

    // Log available keys for debugging
    console.log("Available users:", Object.keys(usernameMap));

    const chatId = usernameMap[cleanUsername];

    if (chatId) {
        res.json({ success: true, userId: chatId, username: cleanUsername });
    } else {
        res.status(404).json({ error: "User not found. Please start the Telegram bot first." });
    }
});

// Get Projects for User
app.get('/api/projects', (req, res) => {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: "User ID required" });

    const userProjects = [];

    // Iterate over projectStore
    Object.keys(projectStore).forEach(key => {
        const p = projectStore[key];
        // Check if user is involved
        // Fix: backend uses 'freelancerId' in storing accepted projects, but 'freelancer' in some chat states. Check both.
        if (p.clientChatId === userId || p.freelancer === userId || p.freelancerId === userId || p.clientId === userId) {
            // Add ID to object for frontend
            userProjects.push({ ...p, id: key });
        }
    });

    res.json(userProjects);
});

// Get Single Project
app.get('/api/projects/:id', (req, res) => {
    const projectId = req.params.id;
    const project = projectStore[projectId];
    if (project) {
        res.json({ ...project, id: projectId });
    } else {
        res.status(404).json({ error: "Project not found" });
    }
});

// Send Chat Message
app.post('/api/chat/:id', async (req, res) => {
    const projectId = req.params.id;
    const { userId, text } = req.body;
    const project = projectStore[projectId];

    if (!project) return res.status(404).json({ error: "Project not found" });

    // Validate user
    const senderId = parseInt(userId);
    console.log(`Processing chat for project ${projectId} by user ${senderId}`);
    console.log(`Project Data:`, JSON.stringify(project, null, 2));

    const isClient = (project.clientChatId === senderId || project.clientId === senderId);
    const isFreelancer = (project.freelancer === senderId || project.freelancerId === senderId);

    if (!isClient && !isFreelancer) {
        console.log(`Auth failed for ${senderId}. Client: ${project.clientChatId}, Freelancer: ${project.freelancerId}`);
        return res.status(403).json({ error: "Unauthorized" });
    }

    const role = isClient ? 'client' : 'freelancer';
    // Get proper username
    let username = "Unknown";
    const freelancerId = project.freelancer || project.freelancerId;

    if (isClient && chatStates[project.clientChatId]) {
        username = chatStates[project.clientChatId].username;
    }
    if (isFreelancer && chatStates[freelancerId]) {
        username = chatStates[freelancerId].freelancerUsername || chatStates[freelancerId].username;
    }

    // Add to conversation history
    if (!project.project.conversation) project.project.conversation = [];
    const msgObj = {
        role: role,
        username: username,
        text: text,
        timestamp: new Date().toISOString()
    };
    project.project.conversation.push(msgObj);

    // Sync to Telegram (Send to OTHER party)
    const targetId = isClient ? freelancerId : (project.clientChatId || project.clientId);
    if (targetId) {
        try {
            await bot.telegram.sendMessage(targetId, `📩 **Web Message from ${username}:**\n\n${text}`);
        } catch (e) {
            console.error("Failed to send TG message:", e);
        }
    }

    saveState();
    res.json({ success: true, message: msgObj });
});

app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(3000, () => console.log('Server running on port 3000'));
