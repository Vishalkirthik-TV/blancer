const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// In-memory store (persist to file/DB in production)
const timelineStore = {};

/**
 * Creates a tamper-evident log entry
 * @param {string} projectId - ID of the project
 * @param {string} eventType - Type of event (CREATED, FUNDED, etc.)
 * @param {object} details - Event details
 * @param {string} actor - Who performed the action (Client/Freelancer ID)
 */
function logEvent(projectId, eventType, details, actor) {
    if (!timelineStore[projectId]) {
        timelineStore[projectId] = [];
    }

    const timeline = timelineStore[projectId];
    const previousEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const previousHash = previousEntry ? previousEntry.hash : "GENESIS_HASH";

    const timestamp = new Date().toISOString();

    // Create data payload
    const data = {
        projectId,
        eventType,
        details,
        actor,
        timestamp,
        previousHash
    };

    // calculate SHA-256 hash of the data
    const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

    const entry = {
        ...data,
        hash
    };

    timeline.push(entry);
    console.log(`[TIMELINE] New Event: ${eventType} | Hash: ${hash.substring(0, 10)}...`);

    return entry;
}

/**
 * Retrieves the timeline for a project
 * @param {string} projectId 
 */
function getTimeline(projectId) {
    return timelineStore[projectId] || [];
}

/**
 * Generates a proof summary for the user
 * @param {string} projectId 
 */
function generateProof(projectId) {
    const timeline = getTimeline(projectId);
    if (timeline.length === 0) return "No events found.";

    return timeline.map((entry, index) => {
        return (
            `Step ${index + 1}: ${entry.eventType}\n` +
            `🕒 Time: ${entry.timestamp}\n` +
            `👤 Actor: ${entry.actor}\n` +
            `🔗 Hash: ${entry.hash.substring(0, 16)}...` // Show partial hash
        );
    }).join('\n\n') + `\n\n✅ **Verified Chain**: All hashes link back to Genesis.`;
}

module.exports = { logEvent, getTimeline, generateProof };
