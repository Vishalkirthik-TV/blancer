const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Fallback Regex Extraction (Simple backup)
function extractWithRegex(text) {
    return {
        scope: text,
        budget: 0,
        currency: 'USD',
        timeline_days: 7
    };
}

// Conversational Agent to extract project details
async function processProjectConversation(history, userInput) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("No GEMINI_API_KEY. Using legacy regex fallback.");
        return { status: 'complete', data: extractWithRegex(userInput) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = "models/gemini-2.5-flash"; // Or 1.5-flash
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

    // Construct context-aware prompt
    const systemPrompt = `
    You are the AI Escrow Agent for "Blancer", a secure crypto-escrow service.
    Your SOLE GOAL is to finalize the contract terms (Scope, Budget, Currency, Timeline) efficiently.

    TONE: Professional, Concise, Transaction-focused. No small talk. No "Hi there".
    
    Current Conversation History:
    ${history.map(h => `${h.role}: ${h.text}`).join('\n')}
    
    Latest User Input: "${userInput}"

    INSTRUCTIONS:
    - Analyze the input.
    - If details are missing, ask for them DIRECTLY. 
      Example: "Received scope. What is the budget in USD?"
      NOT: "That sounds like a great project! Could you tell me..."
    - If ALL 4 details (Scope, Budget, Currency, Timeline) are clear:
      - If you haven't asked about additional documents/info yet, ask: "Do you have any relevant documents or additional details to add?"
      - If the user provides documents/info OR says "test", "no", "none", or is clearly finished, THEN output JSON status "complete".

    OUTPUT FORMAT (Return ONLY ONE of these JSON structures, no markdown):

    Outcome 1: Information Incomplete
    {
        "status": "incomplete",
        "reply": "Direct question for missing info."
    }

    Outcome 2: Information Complete
    {
        "status": "complete",
        "data": {
            "scope": "Summarized scope",
            "budget": 100,
            "currency": "USD",
            "timeline_days": 7,
            "additional_info": "Summary of any extra details or 'None'"
        },
        "reply": "Terms captured. Ready to confirm."
    }
    `;

    try {
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: systemPrompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });

        const generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Clean and parse JSON
        const cleanJson = generatedText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);

            // Post-processing: remove ** from reply if present
            if (result.reply) {
                result.reply = result.reply.replace(/\*\*/g, '');
            }

            console.log("AI Agent Decision:", result);
            return result;
        } else {
            console.error("AI returned invalid JSON:", cleanJson);
            return { status: 'incomplete', reply: "Could you clarify the budget and timeline?" };
        }

    } catch (error) {
        console.error("Agent Error:", error.message);
        return {
            status: 'incomplete',
            reply: "I'm having trouble connecting to my brain. Can you tell me the budget and duration?"
        };
    }
}

// Generate Project Summary & Status
async function generateProjectSummary(projectData, conversationHistory) {
    if (!process.env.GEMINI_API_KEY) {
        return "⚠️ AI Service Unavailable (No API Key).";
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = "models/gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

    // Format Milestones
    let milestonesText = "None";
    if (projectData.milestones) {
        milestonesText = projectData.milestones.map((m, i) =>
            `${i + 1}. ${m.description} (${m.amount}) - [${m.status}]`
        ).join('\n');
    }

    // Format Conversation
    let chatLog = "No recent messages.";
    if (conversationHistory && conversationHistory.length > 0) {
        chatLog = conversationHistory.map(m => `[${m.role}]: ${m.text}`).join('\n');
    }

    const prompt = `
    You are the Project Manager AI for a freelance contract.
    Summarize the current status based on the data below.

    PROJECT DETAILS:
    - Scope: ${projectData.scope}
    - Budget: ${projectData.budget} ${projectData.currency}
    - Timeline: ${projectData.timeline_days} days
    - Payment Type: ${projectData.paymentType || 'One-Time'}
    - Milestones:
    ${milestonesText}

    RECENT CONVERSATION LOG:
    ${chatLog}

    OUTPUT INSTRUCTIONS:
    - Provide a bulleted summary.
    - Highlight what is currently pending (e.g. "Waiting for Milestone 2 submission").
    - Summarize any key agreements or changes discussed in the chat log.
    - Keep it under 200 words.
    - Neutral, professional tone.
    `;

    try {
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });

        let text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ Could not generate summary.";
        return text.replace(/\*\*/g, '').replace(/(__)/g, '');

    } catch (error) {
        console.error("Summary Gen Error:", error.message);
        return "⚠️ AI Error: Could not generate summary.";
    }
}

module.exports = { processProjectConversation, generateProjectSummary };
