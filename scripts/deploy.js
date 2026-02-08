const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

// Contract ABI and Bytecode (inline for simplicity - in production use compiled artifacts)
const ESCROW_ABI = [
    "function createEscrow(address _freelancer, string memory _description, bytes32 _agreementHash) external payable returns (uint256)",
    "function releaseFunds(uint256 _escrowId) external",
    "function raiseDispute(uint256 _escrowId) external",
    "function refundClient(uint256 _escrowId) external",
    "function escrows(uint256) external view returns (address client, address freelancer, uint256 amount, uint8 state, string memory description, bytes32 agreementHash)",
    "function escrowCounter() external view returns (uint256)",
    "event EscrowCreated(uint256 indexed escrowId, address indexed client, address indexed freelancer, uint256 amount)",
    "event EscrowFunded(uint256 indexed escrowId, uint256 amount)",
    "event FundsReleased(uint256 indexed escrowId, address indexed freelancer, uint256 amount)",
    "event DisputeRaised(uint256 indexed escrowId)",
    "event FundsRefunded(uint256 indexed escrowId, address indexed client, uint256 amount)",
    "event AgreementHashStored(uint256 indexed escrowId, bytes32 agreementHash)"
];

// Solidity source for compilation
const SOLIDITY_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EscrowSystem {
    enum State { Created, Funded, Released, Disputed, Refunded }

    struct Escrow {
        address client;
        address freelancer;
        uint256 amount;
        State state;
        string description;
        bytes32 agreementHash;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public escrowCounter;

    event EscrowCreated(uint256 indexed escrowId, address indexed client, address indexed freelancer, uint256 amount);
    event EscrowFunded(uint256 indexed escrowId, uint256 amount);
    event FundsReleased(uint256 indexed escrowId, address indexed freelancer, uint256 amount);
    event DisputeRaised(uint256 indexed escrowId);
    event FundsRefunded(uint256 indexed escrowId, address indexed client, uint256 amount);
    event AgreementHashStored(uint256 indexed escrowId, bytes32 agreementHash);

    function createEscrow(address _freelancer, string memory _description, bytes32 _agreementHash) external payable returns (uint256) {
        require(msg.value > 0, "Amount must be greater than 0");
        require(_freelancer != address(0), "Invalid freelancer address");

        escrowCounter++;
        escrows[escrowCounter] = Escrow({
            client: msg.sender,
            freelancer: _freelancer,
            amount: msg.value,
            state: State.Funded,
            description: _description,
            agreementHash: _agreementHash
        });

        emit EscrowCreated(escrowCounter, msg.sender, _freelancer, msg.value);
        emit EscrowFunded(escrowCounter, msg.value);
        emit AgreementHashStored(escrowCounter, _agreementHash);

        return escrowCounter;
    }

    function releaseFunds(uint256 _escrowId, address payable _recipient) external {
        Escrow storage escrow = escrows[_escrowId];
        require(msg.sender == escrow.client, "Only client can release funds");
        require(escrow.state == State.Funded, "Escrow not in funded state");
        require(_recipient != address(0), "Invalid recipient address");

        escrow.state = State.Released;
        _recipient.transfer(escrow.amount);

        emit FundsReleased(_escrowId, _recipient, escrow.amount);
    }

    function raiseDispute(uint256 _escrowId) external {
        Escrow storage escrow = escrows[_escrowId];
        require(msg.sender == escrow.client || msg.sender == escrow.freelancer, "Only participants can raise dispute");
        require(escrow.state == State.Funded, "Escrow not in funded state");

        escrow.state = State.Disputed;
        emit DisputeRaised(_escrowId);
    }

    function refundClient(uint256 _escrowId) external {
        Escrow storage escrow = escrows[_escrowId];
        require(msg.sender == escrow.freelancer, "Only freelancer can refund (for this MVP)");
        require(escrow.state == State.Funded || escrow.state == State.Disputed, "Invalid state for refund");

        escrow.state = State.Refunded;
        payable(escrow.client).transfer(escrow.amount);

        emit FundsRefunded(_escrowId, escrow.client, escrow.amount);
    }
}
`;

async function deploy() {
    console.log("=== MONAD ESCROW CONTRACT DEPLOYMENT ===\n");

    const RPC_URL = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    const CHAIN_ID = parseInt(process.env.CHAIN_ID) || 10143;

    if (!PRIVATE_KEY) {
        console.error("❌ ERROR: PRIVATE_KEY not found in .env");
        process.exit(1);
    }

    console.log("🔗 RPC URL:", RPC_URL);
    console.log("🔗 Chain ID:", CHAIN_ID);

    try {
        // Connect to Monad testnet
        const provider = new ethers.JsonRpcProvider(RPC_URL, {
            chainId: CHAIN_ID,
            name: "monad-testnet"
        });

        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log("👛 Deployer Address:", wallet.address);

        // Check balance
        const balance = await provider.getBalance(wallet.address);
        console.log("💰 Balance:", ethers.formatEther(balance), "MON\n");

        if (balance === 0n) {
            console.error("❌ ERROR: No MON balance. Please fund your wallet with testnet tokens.");
            process.exit(1);
        }

        // Compile contract using solc
        const solc = require('solc');

        const input = {
            language: 'Solidity',
            sources: { 'EscrowSystem.sol': { content: SOLIDITY_SOURCE } },
            settings: { outputSelection: { '*': { '*': ['*'] } } }
        };

        console.log("📦 Compiling contract...");
        const output = JSON.parse(solc.compile(JSON.stringify(input)));

        if (output.errors) {
            const errors = output.errors.filter(e => e.severity === 'error');
            if (errors.length > 0) {
                console.error("❌ Compilation errors:", errors);
                process.exit(1);
            }
        }

        const contract = output.contracts['EscrowSystem.sol']['EscrowSystem'];
        const bytecode = contract.evm.bytecode.object;
        const abi = contract.abi;

        console.log("✅ Contract compiled successfully!\n");

        // Deploy
        console.log("🚀 Deploying to Monad Testnet...");
        const factory = new ethers.ContractFactory(abi, bytecode, wallet);
        const escrowContract = await factory.deploy();

        console.log("⏳ Waiting for confirmation...");
        await escrowContract.waitForDeployment();

        const contractAddress = await escrowContract.getAddress();
        console.log("\n✅ CONTRACT DEPLOYED SUCCESSFULLY!");
        console.log("📍 Address:", contractAddress);
        console.log("🔗 Explorer: https://testnet.monadexplorer.com/address/" + contractAddress);

        // Save ABI to file
        const artifactsDir = path.join(__dirname, '../artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(artifactsDir, 'EscrowSystem.json'),
            JSON.stringify({ abi, address: contractAddress }, null, 2)
        );
        console.log("\n📁 ABI saved to artifacts/EscrowSystem.json");

        // Update .env with contract address
        const envPath = path.join(__dirname, '../backend/.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/CONTRACT_ADDRESS=.*/, `CONTRACT_ADDRESS=${contractAddress}`);
        fs.writeFileSync(envPath, envContent);
        console.log("📝 Updated .env with CONTRACT_ADDRESS");

        console.log("\n=== DEPLOYMENT COMPLETE ===");

    } catch (error) {
        console.error("❌ Deployment failed:", error.message);
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.error("Please fund your wallet with testnet MON tokens.");
        }
        process.exit(1);
    }
}

deploy();
