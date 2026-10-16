// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ComputePassVoucher
/// @notice Capacity voucher registry. One token id represents one independently
///         expiring balance; the issuer may mint after an x402 settlement and
///         an approved redeemer may burn capacity after serving inference.
contract ComputePassVoucher {
    struct Pass {
        address owner;
        uint128 issuedUnits;
        uint128 remainingUnits;
        uint64 expiresAt;
        bytes32 termsHash;
    }

    address public owner;
    mapping(address => bool) public issuers;
    mapping(address => bool) public redeemers;
    mapping(uint256 => Pass) private _passes;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IssuerSet(address indexed account, bool allowed);
    event RedeemerSet(address indexed account, bool allowed);
    event VoucherMinted(uint256 indexed tokenId, address indexed holder, uint256 units, uint64 expiresAt, bytes32 termsHash);
    event VoucherTransferred(uint256 indexed tokenId, address indexed from, address indexed to);
    event CapacityRedeemed(uint256 indexed tokenId, address indexed holder, uint256 units, bytes32 indexed redemptionId);

    error Unauthorized();
    error InvalidVoucher();
    error Expired();
    error InsufficientCapacity();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert Unauthorized();
        owner = initialOwner;
        issuers[initialOwner] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit IssuerSet(initialOwner, true);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    function setIssuer(address account, bool allowed) external onlyOwner {
        issuers[account] = allowed;
        emit IssuerSet(account, allowed);
    }

    function setRedeemer(address account, bool allowed) external onlyOwner {
        redeemers[account] = allowed;
        emit RedeemerSet(account, allowed);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert Unauthorized();
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    function mintVoucher(
        uint256 tokenId,
        address holder,
        uint128 units,
        uint64 expiresAt,
        bytes32 termsHash
    ) external {
        if (!issuers[msg.sender]) revert Unauthorized();
        if (holder == address(0) || units == 0 || expiresAt <= block.timestamp || _passes[tokenId].owner != address(0)) revert InvalidVoucher();
        _passes[tokenId] = Pass(holder, units, units, expiresAt, termsHash);
        emit VoucherMinted(tokenId, holder, units, expiresAt, termsHash);
    }

    function transferVoucher(uint256 tokenId, address to) external {
        Pass storage pass = _passes[tokenId];
        if (pass.owner != msg.sender || to == address(0)) revert Unauthorized();
        if (pass.expiresAt <= block.timestamp) revert Expired();
        address from = pass.owner;
        pass.owner = to;
        emit VoucherTransferred(tokenId, from, to);
    }

    function redeem(uint256 tokenId, uint128 units, bytes32 redemptionId) external {
        if (!redeemers[msg.sender]) revert Unauthorized();
        Pass storage pass = _passes[tokenId];
        if (pass.owner == address(0)) revert InvalidVoucher();
        if (pass.expiresAt <= block.timestamp) revert Expired();
        if (units == 0 || pass.remainingUnits < units) revert InsufficientCapacity();
        pass.remainingUnits -= units;
        emit CapacityRedeemed(tokenId, pass.owner, units, redemptionId);
    }

    function voucher(uint256 tokenId) external view returns (Pass memory) {
        return _passes[tokenId];
    }
}
