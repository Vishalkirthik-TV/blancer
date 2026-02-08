const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

// Transak Configuration
const TRANSAK_API_KEY = process.env.TRANSAK_API_KEY;
const TRANSAK_API_SECRET = process.env.TRANSAK_API_SECRET;
const TRANSAK_ENV = process.env.TRANSAK_ENVIRONMENT || 'STAGING';

// API endpoints
const STAGING_BASE_URL = 'https://api-gateway-stg.transak.com';
const PRODUCTION_BASE_URL = 'https://api-gateway.transak.com';
const BASE_URL = TRANSAK_ENV === 'PRODUCTION' ? PRODUCTION_BASE_URL : STAGING_BASE_URL;

// Widget URLs
const STAGING_WIDGET_URL = 'https://global-stg.transak.com';
const PRODUCTION_WIDGET_URL = 'https://global.transak.com';
const WIDGET_URL = TRANSAK_ENV === 'PRODUCTION' ? PRODUCTION_WIDGET_URL : STAGING_WIDGET_URL;

console.log("=== TRANSAK SERVICE CONFIG ===");
console.log("Environment:", TRANSAK_ENV);
console.log("API Key:", TRANSAK_API_KEY ? TRANSAK_API_KEY.substring(0, 8) + "..." : "(not set)");
console.log("==============================");

// Store access token
let cachedAccessToken = null;
let tokenExpiresAt = 0;

/**
 * Refresh Transak access token
 * @returns {Promise<string>} Access token
 */
async function refreshAccessToken() {
    try {
        const response = await axios.post(
            `${BASE_URL}/api/v2/auth/session`,
            {
                widgetParams: {
                    apiKey: TRANSAK_API_KEY,
                    referrerDomain: "zent.escrow",
                    cryptoCurrencyCode: "USDT",
                    fiatCurrency: "INR"
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'accept': 'application/json'
                }
            }
        );

        if (response.data && response.data.data) {
            cachedAccessToken = response.data.data.accessToken;
            tokenExpiresAt = response.data.data.expiresAt * 1000; // Convert to ms
            console.log("[TRANSAK] Access token refreshed, expires:", new Date(tokenExpiresAt).toISOString());
            return cachedAccessToken;
        }

        throw new Error("Invalid token response");
    } catch (error) {
        console.error("[TRANSAK] Token refresh error:", error.message);
        return null;
    }
}

/**
 * Get valid access token (refresh if expired)
 */
async function getAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedAccessToken;
    }
    return await refreshAccessToken();
}

/**
 * Generate Transak widget URL for INR payment
 * @param {number} amountINR - Amount in Indian Rupees
 * @param {string} walletAddress - Destination wallet address (escrow)
 * @param {string} orderId - Unique order/escrow ID for tracking
 * @returns {string} - Widget URL for payment
 */
function generatePaymentUrl(amountINR, walletAddress, orderId) {
    // Build query parameters for the widget
    const params = new URLSearchParams({
        apiKey: TRANSAK_API_KEY,
        environment: TRANSAK_ENV,

        // Fiat settings
        fiatCurrency: 'INR',
        fiatAmount: amountINR.toString(),

        // Crypto settings - using USDT on a supported network
        // Note: Monad not directly supported, so we use bridgeable tokens
        cryptoCurrencyCode: 'USDT',
        network: 'polygon', // Use Polygon USDT, then bridge if needed

        // Wallet address (escrow wallet)
        walletAddress: walletAddress,

        // Disable crypto amount editing
        disableWalletAddressForm: 'true',

        // Order tracking
        partnerOrderId: orderId,

        // Hide network selection
        hideMenu: 'true',

        // SKIP KYC - For sandbox/demo mode
        // These params help skip or simplify KYC for testing
        // isAutoFillUserData: 'true',
        // email: 'demo@blancer.escrow',
        // userData: JSON.stringify({
        //     firstName: 'Demo',
        //     lastName: 'User',
        //     email: 'demo@blancer.escrow',
        //     mobileNumber: '+919999999999',
        //     dob: '1990-01-01',
        //     address: {
        //         addressLine1: 'Demo Address',
        //         city: 'Mumbai',
        //         state: 'Maharashtra',
        //         postCode: '400001',
        //         countryCode: 'IN'
        //     }
        // }),

        // Theme
        themeColor: '6366f1', // Indigo
    });

    const url = `${WIDGET_URL}?${params.toString()}`;
    console.log("[TRANSAK] Payment URL generated for ₹" + amountINR);

    return url;
}

/**
 * Check order status (for verification)
 * @param {string} orderId - Transak order ID
 */
async function checkOrderStatus(orderId) {
    try {
        const token = await getAccessToken();
        if (!token) return { success: false, error: "No access token" };

        const response = await axios.get(
            `${BASE_URL}/api/v2/orders/${orderId}`,
            {
                headers: {
                    'access-token': token,
                    'accept': 'application/json'
                }
            }
        );

        return {
            success: true,
            data: response.data
        };
    } catch (error) {
        console.error("[TRANSAK] Order status error:", error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Simulate off-ramp payout (MOCKED - Transak doesn't support India off-ramp)
 * @param {number} amountINR - Amount to "pay out"
 * @param {string} freelancerId - Freelancer's ID
 * @param {object} bankDetails - Bank account info (mocked)
 */
function simulateOffRampPayout(amountINR, freelancerId, bankDetails = {}) {
    console.log(`[TRANSAK-MOCK] Simulating INR payout: ₹${amountINR} to freelancer ${freelancerId}`);

    // In production, this would integrate with a licensed payout partner
    // For hackathon demo, we just log and return success

    const mockTxId = 'PAYOUT_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    return {
        success: true,
        mocked: true,
        transactionId: mockTxId,
        amount: amountINR,
        currency: 'INR',
        message: `₹${amountINR} payout simulated (demo mode)`,
        note: "Off-ramp via licensed payout partner in production"
    };
}

/**
 * Get escrow wallet address for receiving on-ramp funds
 * In production, this could be:
 * 1. The smart contract address
 * 2. A system custody wallet
 * 3. A per-escrow generated wallet
 */
function getEscrowReceivingAddress() {
    // For demo: use deployed contract address
    // In production with USDT: would use a custody wallet that can receive USDT
    return process.env.CONTRACT_ADDRESS || "0xD381F64520E2E0dBC3A569e11dB29303621410a3";
}

module.exports = {
    generatePaymentUrl,
    checkOrderStatus,
    refreshAccessToken,
    simulateOffRampPayout,
    getEscrowReceivingAddress,
    TRANSAK_ENV
};
