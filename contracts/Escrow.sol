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
        bytes32 agreementHash; // SHA-256 hash of off-chain agreement for privacy
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
            state: State.Funded, // Immediately funded for simplicity in this MVP
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
        // In a real system, this would be called by an arbiter or after a timeout
        // For MVP/Demo, we allow the freelancer to refund the client if they agree, or maybe the client can cancel if not started (simplified here)
        Escrow storage escrow = escrows[_escrowId];
        require(msg.sender == escrow.freelancer, "Only freelancer can refund (for this MVP)"); 
        require(escrow.state == State.Funded || escrow.state == State.Disputed, "Invalid state for refund");

        escrow.state = State.Refunded;
        payable(escrow.client).transfer(escrow.amount);

        emit FundsRefunded(_escrowId, escrow.client, escrow.amount);
    }
}
