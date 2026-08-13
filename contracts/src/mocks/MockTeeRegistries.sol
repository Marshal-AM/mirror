// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ITeeExtensionRegistry } from "../interfaces/ITeeExtensionRegistry.sol";

/// @dev Test double for FlareTeeManager diamond facets used by AiAgentSender.
contract MockTeeRegistries {
    uint256 public nextPublicExtensionId = 0x10000;
    mapping(uint256 => address) public senders;
    bytes32 public lastInstructionId;

    function register(uint256 id, address sender) external {
        senders[id] = sender;
        if (id + 1 > nextPublicExtensionId) {
            nextPublicExtensionId = id + 1;
        }
    }

    function getTeeExtensionInstructionsSender(uint256 id) external view returns (address) {
        return senders[id];
    }

    function getRandomTeeIds(uint256, uint256 count) external view returns (address[] memory ids) {
        ids = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = address(this);
        }
    }

    function sendInstructions(
        address[] calldata,
        ITeeExtensionRegistry.TeeInstructionParams calldata
    ) external payable returns (bytes32) {
        lastInstructionId = keccak256(abi.encodePacked("mock-instruction", msg.sender, msg.value));
        return lastInstructionId;
    }
}
