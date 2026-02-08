const { ethers } = require('ethers');
const crypto = require('crypto');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

// Configuration
const RPC_URL = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const CHAIN_ID = parseInt(process.env.CHAIN_ID) || 10143;

// Check if we should use mock mode
const isPlaceholder = !PRIVATE_KEY || PRIVATE_KEY.includes('your_') || PRIVATE_KEY.length < 32;
const hasContractAddress = CONTRACT_ADDRESS && CONTRACT_ADDRESS.length > 10;
const MOCK_MODE = isPlaceholder || !hasContractAddress;

console.log("=== ESCROW SERVICE CONFIG ===");
console.log("PRIVATE_KEY provided:", !!PRIVATE_KEY);
console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS || "(not set)");
console.log("RPC_URL:", RPC_URL);
console.log("CHAIN_ID:", CHAIN_ID);
console.log("MOCK_MODE ACTIVE:", MOCK_MODE);
if (MOCK_MODE && !isPlaceholder && !hasContractAddress) {
    console.log("⚠️  Mock mode: Contract not deployed yet. Run: node scripts/deploy.js");
}
console.log("=============================");

// Contract ABI (simplified interface)
const ESCROW_ABI = [
    "function createEscrow(address _freelancer, string memory _description, bytes32 _agreementHash) external payable returns (uint256)",
    "function releaseFunds(uint256 _escrowId, address payable _recipient) external",
    "function raiseDispute(uint256 _escrowId) external",
    "function refundClient(uint256 _escrowId) external",
    "function escrows(uint256) external view returns (address client, address freelancer, uint256 amount, uint8 state, string memory description, bytes32 agreementHash)",
    "function escrowCounter() external view returns (uint256)",
    "event EscrowCreated(uint256 indexed escrowId, address indexed client, address indexed freelancer, uint256 amount)",
    "event FundsReleased(uint256 indexed escrowId, address indexed freelancer, uint256 amount)",
    "event AgreementHashStored(uint256 indexed escrowId, bytes32 agreementHash)"
];

// Provider and Wallet (initialized lazily)
let provider = null;
let wallet = null;
let contract = null;

function initBlockchain() {
    if (!MOCK_MODE && !provider) {
        provider = new ethers.JsonRpcProvider(RPC_URL, {
            chainId: CHAIN_ID,
            name: "monad-testnet"
        });
        provider.pollingInterval = 10000; // Slow down polling to avoid rate limits (25 req/sec limit)
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        contract = new ethers.Contract(CONTRACT_ADDRESS, ESCROW_ABI, wallet);
        console.log("🔗 Blockchain connection initialized");
        console.log("👛 Wallet address:", wallet.address);
    }
}

/**
 * Creates a SHA-256 hash of the project agreement for on-chain storage
 * @param {object} projectData - Project details (scope, budget, etc.)
 * @param {string} clientId - Telegram client ID
 * @param {string} freelancerId - Telegram freelancer ID
 * @returns {string} - bytes32 hash (0x prefixed)
 */
function hashAgreement(projectData, clientId, freelancerId) {
    const agreementData = {
        scope: projectData.scope,
        budget: projectData.budget,
        currency: projectData.currency,
        timeline_days: projectData.timeline_days,
        clientId: clientId.toString(),
        freelancerId: freelancerId.toString(),
        timestamp: new Date().toISOString().split('T')[0] // Date only for consistency
    };

    const jsonString = JSON.stringify(agreementData, Object.keys(agreementData).sort());
    const hash = crypto.createHash('sha256').update(jsonString).digest('hex');

    console.log("[PRIVACY] Agreement hashed (SHA-256):", hash.substring(0, 16) + "...");
    console.log("[PRIVACY] Off-chain data stored locally. Only hash goes on-chain.");

    return '0x' + hash;
}

/**
 * Fund escrow on Monad blockchain
 * @param {number} amount - Amount in native currency units (for demo, treated as MON wei * 10^-18)
 * @param {string} freelancerAddress - Ethereum address of freelancer (or use placeholder for demo)
 * @param {object} projectData - Full project data for hashing
 * @param {string} clientId - Telegram client ID
 * @param {string} freelancerId - Telegram freelancer ID
 */
async function fundEscrow(amount, freelancerAddress, projectData = {}, clientId = '', freelancerId = '') {
    if (MOCK_MODE) {
        console.log(`[MOCK] Funding escrow: ${amount} for freelancer ${freelancerAddress}`);
        const mockHash = hashAgreement(projectData, clientId, freelancerId);
        return {
            success: true,
            hash: "0x" + crypto.randomBytes(32).toString('hex'),
            escrowId: Math.floor(Math.random() * 1000),
            agreementHash: mockHash,
            mock: true
        };
    }

    try {
        initBlockchain();

        // Generate agreement hash
        const agreementHash = hashAgreement(projectData, clientId, freelancerId);

        // For demo: Use a placeholder address if freelancer hasn't provided a wallet
        // In production, freelancer would provide their wallet address
        const freelancerWallet = ethers.isAddress(freelancerAddress)
            ? freelancerAddress
            : "0x0000000000000000000000000000000000000001"; // Placeholder for demo

        // Convert amount to wei - using minimal amount to conserve testnet tokens
        // 0.0001 MON = 100000000000000 wei (minimal valid escrow for demo)
        const valueInWei = ethers.parseEther("0.0001");

        console.log(`🔒 Creating escrow on Monad...`);
        console.log(`   Amount: ${ethers.formatEther(valueInWei)} MON`);
        console.log(`   Freelancer: ${freelancerWallet}`);
        console.log(`   Agreement Hash: ${agreementHash.substring(0, 18)}...`);

        const tx = await contract.createEscrow(
            freelancerWallet,
            projectData.scope || "Project Escrow",
            agreementHash,
            { value: valueInWei }
        );

        console.log(`⏳ Transaction sent: ${tx.hash}`);
        console.log(`   Explorer: https://testnet.monadexplorer.com/tx/${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

        // Parse escrow ID from events
        let escrowId = null;
        for (const log of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog(log);
                if (parsed && parsed.name === 'EscrowCreated') {
                    escrowId = parsed.args[0].toString();
                    break;
                }
            } catch (e) { /* Skip unparseable logs */ }
        }

        return {
            success: true,
            hash: tx.hash,
            escrowId: escrowId,
            agreementHash: agreementHash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error("❌ Escrow Fund Error:", error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Release funds to freelancer or specific recipient
 * @param {number|string} escrowId - The escrow ID on the contract
 * @param {string} recipientAddress - The address to release funds to (freelancer wallet or off-ramp)
 */
async function releaseFunds(escrowId, recipientAddress) {
    if (MOCK_MODE) {
        console.log(`[MOCK] Releasing funds for escrow ID: ${escrowId} to ${recipientAddress}`);
        return {
            success: true,
            hash: "0x" + crypto.randomBytes(32).toString('hex'),
            mock: true
        };
    }

    try {
        initBlockchain();

        if (!ethers.isAddress(recipientAddress)) {
            throw new Error("Invalid recipient address");
        }

        console.log(`💸 Releasing funds for escrow #${escrowId} to ${recipientAddress}...`);

        const tx = await contract.releaseFunds(escrowId, recipientAddress);
        console.log(`⏳ Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✅ Funds released in block ${receipt.blockNumber}`);

        return {
            success: true,
            hash: tx.hash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error("❌ Release Funds Error:", error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Raise a dispute for an escrow
 * @param {number|string} escrowId - The escrow ID on the contract
 */
async function raiseDispute(escrowId) {
    if (MOCK_MODE) {
        console.log(`[MOCK] Raising dispute for escrow ID: ${escrowId}`);
        return {
            success: true,
            hash: "0x" + crypto.randomBytes(32).toString('hex'),
            mock: true
        };
    }

    try {
        initBlockchain();

        console.log(`⚠️ Raising dispute for escrow #${escrowId}...`);

        const tx = await contract.raiseDispute(escrowId);
        console.log(`⏳ Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✅ Dispute raised in block ${receipt.blockNumber}`);

        return {
            success: true,
            hash: tx.hash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error("❌ Raise Dispute Error:", error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Get escrow details from blockchain
 * @param {number|string} escrowId - The escrow ID
 */
async function getEscrowDetails(escrowId) {
    if (MOCK_MODE) {
        return { success: false, error: "Mock mode - no on-chain data" };
    }

    try {
        initBlockchain();

        const escrow = await contract.escrows(escrowId);

        return {
            success: true,
            data: {
                client: escrow[0],
                freelancer: escrow[1],
                amount: ethers.formatEther(escrow[2]),
                state: ['Created', 'Funded', 'Released', 'Disputed', 'Refunded'][escrow[3]],
                description: escrow[4],
                agreementHash: escrow[5]
            }
        };

    } catch (error) {
        console.error("❌ Get Escrow Error:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    fundEscrow,
    releaseFunds,
    raiseDispute,
    getEscrowDetails,
    hashAgreement,
    MOCK_MODE
};
