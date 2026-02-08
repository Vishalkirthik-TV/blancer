# ZENT - Telegram Escrow Bot & Agent 🤖🔒

ZENT is a **Chat-Native Escrow System** built on **Telegram** and the **Monad Blockchain**. It empowers freelancers and clients to transact securely without leaving their favorite chat app.

Powered by **Gemini AI** for intelligent project scoping and **Transak** for seamless fiat on-ramps.

---

## 🚀 Key Features

### 1. 🤖 Agentic Project Definition
-   **AI-Powered Scoping**: Just describe your project in plain text. The AI agent extracts the Scope, Budget, and Timeline automatically.
-   **Conversation Awareness**: The agent asks follow-up questions to refine requirements before locking them in.

### 2. 💸 Flexible Payments (Crypto + Fiat)
-   **On-Ramp (Client)**: Clients can fund escrow using **UPI / Bank Transfer** via **Transak** (or direct Crypto).
-   **Payouts (Freelancer)**: Freelancers can choose how they want to be paid:
    -   **Wait for INR**: Funds moved to off-ramp service.
    -   **Receive Crypto**: Funds released directly to their Monad wallet address.

### 3. 🔒 Trustless Escrow (Monad Testnet)
-   **Smart Contracts**: All funds are held in a secure Solidity smart contract on the Monad Testnet.
-   **Immutable Proof**: Every agreement is hashed and stored on-chain.
-   **Automated Release**: Funds are only released when the Client approves the work.

### 4. 📄 Smart Contract PDF 🆕
-   **Instant Documentation**: Freelancers can download a **formatted PDF contract** directly from the bot.
-   **Verifiable**: The PDF includes the **Agreement Hash** and **Transaction ID** for blockchain verification.

### 5. 📂 Workflow Management
-   **Milestones**: Break down large projects into funded milestones.
-   **Submission Tracking**: Freelancers submit work (files/text) via the bot.
-   **Dispute Resolution**: Built-in mechanisms for raising disputes (roadmap).

---

## 🛠️ Tech Stack
-   **Bot Framework**: `Telegraf` (Node.js)
-   **Blockchain**: `Monad Testnet`, `Ethers.js`
-   **AI**: `Google Gemini 1.5 Flash`
-   **Payments**: `Transak` (Fiat On-Ramp)
-   **PDF Generation**: `PDFKit`
-   **Backend**: `Express.js`

---

## ⚙️ Setup & Installation

1.  **Clone the Repo**
    ```bash
    git clone <repo-url>
    cd telegram-escrow-bot
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Environment Variables**
    Create a `.env` file in the root directory:
    ```env
    # Telegram
    BOT_TOKEN=your_telegram_bot_token

    # AI
    GEMINI_API_KEY=your_gemini_api_key

    # Blockchain (Monad Testnet)
    PRIVATE_KEY=your_wallet_private_key
    CONTRACT_ADDRESS=your_deployed_contract_address
    RPC_URL=https://testnet-rpc.monad.xyz

    # Transak
    TRANSAK_API_KEY=your_transak_api_key
    ```

4.  **Deploy Smart Contract** (First Time Only)
    ```bash
    node scripts/deploy.js
    ```
    *Copy the resulting address into your `.env` file.*

5.  **Run the Bot**
    ```bash
    node backend/server.js
    ```

---

## 📱 How to Use

1.  **Start**: Send `/start` to the bot.
2.  **Select Role**: Choose **Client** (Hire) or **Freelancer** (Work).
3.  **Client Flow**:
    -   Describe project to AI.
    -   Confirm terms.
    -   Invite Freelancer (via Username).
    -   Fund Escrow (UPI/Crypto).
4.  **Freelancer Flow**:
    -   Accept Invitation.
    -   Deliver work (upload files).
    -   **Download Contract PDF** for records.
5.  **Completion**:
    -   Client approves work.
    -   Freelancer selects Payout Method (Crypto/INR).
    -   Funds released! 🚀

---

## 📜 License
MIT
