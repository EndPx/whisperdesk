// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title MockFXRP
/// @notice Minimal ERC-20 mock, 6 decimals (matching real FXRP on Coston2 — design.md §3.1).
/// Deliberately NOT 18 decimals: an 18-dec mock would hide the off-by-1e12 bug class (design.md
/// §10). `mint` is unrestricted — test-only.
contract MockFXRP is IERC20 {
    string public constant name = "Mock FXRP";
    string public constant symbol = "FXRP";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockFXRP: insufficient allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockFXRP: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
