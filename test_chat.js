const fetch = require('node-fetch');

async function test() {
    try {
        const id = '1770545283457';
        const userId = '6732245065'; // Client ID
        const myUsername = 'sarangkdkr';

        console.log(`Fetching project ${id}...`);
        const response = await fetch(`http://localhost:3000/api/projects/${id}`);
        const data = await response.json();

        console.log("Project received:", data.id);

        if (data.project && data.project.conversation) {
            console.log("Conversation found, length:", data.project.conversation.length);

            const messages = data.project.conversation;
            const isClient = parseInt(userId) === data.clientChatId || parseInt(userId) === data.clientId;
            console.log("Is Client:", isClient);

            messages.forEach((msg, idx) => {
                const isMe = msg.username === myUsername;
                const isMyRole = (isClient && msg.role === 'client') || (!isClient && msg.role !== 'client');

                console.log(`Msg ${idx}:`, msg.text, "| Role:", msg.role, "| User:", msg.username);
                console.log(`  -> Is Me? ${isMe}`);
                console.log(`  -> Is My Role? ${isMyRole}`);
            });
        } else {
            console.log("No conversation found in project.");
        }

    } catch (e) {
        console.error(e);
    }
}

test();
