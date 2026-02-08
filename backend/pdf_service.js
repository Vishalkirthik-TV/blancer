const PDFDocument = require('pdfkit');

/**
 * Generates a PDF buffer for the contract
 * @param {object} project - Project details
 * @param {object} parties - Client and Freelancer details
 * @param {object} blockchain - Blockchain proofs (hash, address, etc.)
 * @returns {Promise<Buffer>}
 */
function generateContractPDF(project, parties, blockchain) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            resolve(pdfData);
        });

        // --- HEADER ---
        doc.fontSize(25).text('ZENT Escrow Contract', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'right' });
        doc.moveDown();
        doc.moveTo(50, 100).lineTo(550, 100).stroke(); // Horizontal line
        doc.moveDown();

        // --- PARTIES ---
        doc.fontSize(16).text('Parties Involved');
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Client: @${parties.clientUsername || 'Unknown'} (ID: ${parties.clientId})`);
        doc.text(`Freelancer: @${parties.freelancerUsername || 'Unknown'} (ID: ${parties.freelancerId})`);
        doc.moveDown();

        // --- PROJECT DETAILS ---
        doc.fontSize(16).text('Project Details');
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Scope: ${project.scope}`);
        doc.text(`Budget: ${project.budget} ${project.currency}`);
        doc.text(`Timeline: ${project.timeline_days} days`);
        if (project.additional_info && project.additional_info !== 'None') {
            doc.text(`Additional Info: ${project.additional_info}`);
        }

        doc.moveDown();
        doc.text(`Payment Type: ${project.paymentType === 'milestone' ? 'Milestone-based' : 'One-Time Payment'}`);
        if (project.paymentType === 'milestone' && project.milestones) {
            doc.moveDown(0.5);
            doc.text('Milestones:');
            project.milestones.forEach((m, i) => {
                doc.text(`  ${i + 1}. ${m.description}: ${m.amount} (${m.status || 'pending'})`);
            });
        }
        doc.moveDown();

        // --- BLOCKCHAIN PROOF ---
        doc.fontSize(16).text('Blockchain Proof (Monad Testnet)');
        doc.moveDown(0.5);
        doc.fontSize(10).font('Courier');

        doc.text(`Escrow ID: ${blockchain.escrowId || 'Pending'}`);
        doc.text(`Contract Address: ${blockchain.contractAddress}`);
        doc.moveDown(0.5);
        doc.text(`Agreement Hash (SHA-256):`);
        doc.text(blockchain.agreementHash || 'Not generated yet');
        doc.moveDown(0.5);

        if (blockchain.txHash) {
            doc.text(`Funding Transaction Hash:`);
            doc.text(blockchain.txHash);
            doc.moveDown(0.5);
            doc.text(`View on Explorer:`);
            doc.fillColor('blue').text(`https://testnet.monadexplorer.com/tx/${blockchain.txHash}`, { link: `https://testnet.monadexplorer.com/tx/${blockchain.txHash}` });
            doc.fillColor('black');
        } else {
            doc.text('Status: Not yet funded/on-chain');
        }

        // --- FOOTER ---
        doc.moveDown(4);
        doc.fontSize(10).font('Helvetica').text('This document certifies that the above project terms have been hashed and stored on the Monad blockchain for immutable proof of agreement.', { align: 'center' });
        doc.text('Powered by ZENT Escrow Agent', { align: 'center' });

        doc.end();
    });
}

module.exports = { generateContractPDF };
