const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.error("No GEMINI_API_KEY found in .env");
        return;
    }

    try {
        console.log("Fetching available models...\n");

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await axios.get(url);

        const models = response.data.models || [];

        console.log(`Found ${models.length} models:\n`);

        models.forEach(model => {
            const supportsGeneration = model.supportedGenerationMethods?.includes('generateContent');
            console.log(`✓ ${model.name}`);
            console.log(`  Display Name: ${model.displayName}`);
            console.log(`  Supports generateContent: ${supportsGeneration ? 'YES' : 'NO'}`);
            console.log(`  Methods: ${model.supportedGenerationMethods?.join(', ') || 'none'}`);
            console.log('');
        });

    } catch (error) {
        if (error.response) {
            console.error("API Error:", error.response.status, error.response.data);
        } else {
            console.error("Error:", error.message);
        }
    }
}

listModels();
