// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {CovenantCore} from "../contracts/CovenantCore.sol";
import {CovenantDelegate} from "../contracts/CovenantDelegate.sol";
import {CovenantDelegateMainnet} from "../contracts/CovenantDelegateMainnet.sol";
import {MainnetConfig as M} from "../contracts/config/MainnetConfig.sol";
import {IERC20} from "../contracts/interfaces/IERC20.sol";
import {Plans} from "./utils/Plans.sol";

/// Minimal ERC-20 with USDT-like "no non-zero to non-zero approve" behaviour switchable on.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public usdtStyle;

    function setUsdtStyle(bool on) external {
        usdtStyle = on;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(!usdtStyle || amount == 0 || allowance[msg.sender][spender] == 0, "USDT approve");
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Pulls whatever it is allowed to (stands in for a protocol taking an approved amount).
contract Puller {
    function pull(MockToken token, address from, uint256 amount) external {
        token.transferFrom(from, address(this), amount);
    }
}

/// The EIP-7702 delegate on an EOA (delegation designator set with vm.etch, as after a type-4
/// transaction). No fork needed.
contract CovenantDelegateTest is Test {
    uint256 constant PK = 0xC0FFEE;
    address user;
    address attacker = makeAddr("attacker");
    address recipient = makeAddr("recipient");

    CovenantDelegateMainnet impl;
    CovenantDelegateMainnet wallet; // the user's EOA, seen through the delegate's ABI
    MockToken token;
    MockToken other;
    Puller puller;

    function setUp() public {
        user = vm.addr(PK);
        impl = new CovenantDelegateMainnet();
        vm.etch(user, abi.encodePacked(hex"ef0100", address(impl)));
        wallet = CovenantDelegateMainnet(payable(user));

        token = new MockToken();
        other = new MockToken();
        puller = new Puller();
        token.mint(user, 100e6);
        other.mint(user, 50e6);

        vm.startPrank(user);
        wallet.initialize();
        wallet.setRule(address(token), IERC20.transfer.selector, wallet.ALLOWED() | wallet.RECIPIENT_CHECK());
        wallet.setRule(address(token), IERC20.approve.selector, wallet.ALLOWED() | wallet.RECIPIENT_CHECK());
        wallet.setRecipient(address(token), recipient, true);
        wallet.setRecipient(address(token), address(puller), true);
        wallet.setRule(address(puller), Puller.pull.selector, wallet.ALLOWED());
        vm.stopPrank();
    }

    function _tracked() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(token);
    }

    function _exec(CovenantCore.Call[] memory calls) internal {
        vm.prank(user);
        wallet.execute(calls, _tracked(), bytes32("plan"));
    }

    function _one(CovenantCore.Call memory c) internal pure returns (CovenantCore.Call[] memory calls) {
        calls = new CovenantCore.Call[](1);
        calls[0] = c;
    }

    function _two(CovenantCore.Call memory a, CovenantCore.Call memory b)
        internal
        pure
        returns (CovenantCore.Call[] memory calls)
    {
        calls = new CovenantCore.Call[](2);
        (calls[0], calls[1]) = (a, b);
    }

    function _allot(address t, uint256 amount) internal view returns (CovenantCore.Call memory) {
        return Plans.call(user, abi.encodeCall(CovenantDelegate.allot, (t, amount)));
    }

    // ---------------------------------------------------------------- setup and access

    function test_initializeWritesMainnetAllowlist() public view {
        assertEq(wallet.configVersion(), wallet.CONFIG_VERSION());
        assertEq(wallet.rules(M.MORPHO, bytes4(keccak256("flashLoan(address,uint256,bytes)"))), 1);
        assertTrue(wallet.allowedRecipient(M.USDC, M.MORPHO));
        assertEq(wallet.rules(user, CovenantDelegate.allot.selector), 1, "allot callable from plans");
        assertEq(wallet.rules(user, CovenantCore.assertMinOwned.selector), 1);
        // The shared implementation's own storage stays empty.
        assertEq(impl.configVersion(), 0);
    }

    function test_onlyTheWalletItselfCanActOrConfigure() public {
        vm.startPrank(attacker);
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        wallet.execute(new CovenantCore.Call[](0), new address[](0), bytes32(0));
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        wallet.initialize();
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        wallet.setRule(attacker, bytes4(0), 1);
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        wallet.setRecipient(address(token), attacker, true);
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        wallet.allot(address(token), 1);
        vm.stopPrank();
    }

    function test_planCannotCallAdminFunctions() public {
        bytes memory data = abi.encodeCall(CovenantDelegate.setRecipient, (address(token), attacker, true));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, user, bytes4(data)));
        _exec(_one(Plans.call(user, data)));
    }

    function test_implementationCannotBeDrivenDirectly() public {
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        impl.initialize();
        vm.expectRevert(CovenantDelegate.NotSelf.selector);
        impl.execute(new CovenantCore.Call[](0), new address[](0), bytes32(0));
    }

    // ---------------------------------------------------------------- spending

    function test_planCannotSpendWalletFundsItDidNotAllot() public {
        CovenantCore.Call memory send = Plans.call(address(token), abi.encodeCall(IERC20.transfer, (recipient, 10e6)));
        vm.expectRevert(abi.encodeWithSelector(CovenantDelegate.Overspent.selector, address(token), 90e6, 100e6));
        _exec(_one(send));

        _exec(_two(_allot(address(token), 10e6), send));
        assertEq(token.balanceOf(recipient), 10e6);
        assertEq(token.balanceOf(user), 90e6);
    }

    function test_ownedSeesOnlyAllottedFunds() public {
        // "Send all the plan holds" moves the 10 allotted, not the wallet's 100.
        CovenantCore.Call memory sendAll = Plans.patched(
            address(token), abi.encodeCall(IERC20.transfer, (recipient, 0)), Plans.owned(Plans.arg(1), address(token))
        );
        _exec(_two(_allot(address(token), 10e6), sendAll));
        assertEq(token.balanceOf(recipient), 10e6);

        // With nothing allotted the plan holds nothing.
        _exec(_one(sendAll));
        assertEq(token.balanceOf(recipient), 10e6);
    }

    function test_minOwnedGuardIgnoresExistingBalance() public {
        CovenantCore.Call memory guard =
            Plans.call(user, abi.encodeCall(CovenantCore.assertMinOwned, (address(token), 1)));
        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.CallFailed.selector,
                0,
                user,
                abi.encodeWithSelector(CovenantCore.BalanceTooLow.selector, address(token), 0, 1)
            )
        );
        _exec(_one(guard));
        _exec(_two(_allot(address(token), 1), guard));
    }

    function test_untrackedTokensCannotBeAllottedOrMeasured() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.CallFailed.selector,
                0,
                user,
                abi.encodeWithSelector(CovenantDelegate.NotTracked.selector, address(other))
            )
        );
        _exec(_one(_allot(address(other), 1)));

        CovenantCore.Call memory c = Plans.patched(
            address(token), abi.encodeCall(IERC20.transfer, (recipient, 0)), Plans.owned(Plans.arg(1), address(other))
        );
        vm.expectRevert(abi.encodeWithSelector(CovenantDelegate.NotTracked.selector, address(other)));
        _exec(_one(c));
    }

    function test_allotCannotExceedTheWalletBalance() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.CallFailed.selector,
                0,
                user,
                abi.encodeWithSelector(CovenantDelegate.AllotTooLarge.selector, address(token), 101e6, 100e6)
            )
        );
        _exec(_one(_allot(address(token), 101e6)));
    }

    // ---------------------------------------------------------------- approvals

    function test_approvalsArePutBackAfterThePlan() public {
        // An allowance the wallet already had, on a token that rejects non-zero over non-zero.
        token.setUsdtStyle(true);
        vm.prank(user);
        token.approve(address(puller), 5e6);

        CovenantCore.Call memory approve =
            Plans.call(address(token), abi.encodeCall(IERC20.approve, (address(puller), 7e6)));
        CovenantCore.Call memory pull =
            Plans.call(address(puller), abi.encodeCall(Puller.pull, (MockToken(address(token)), user, 3e6)));
        CovenantCore.Call[] memory calls = new CovenantCore.Call[](3);
        (calls[0], calls[1], calls[2]) = (_allot(address(token), 3e6), approve, pull);
        _exec(calls);

        assertEq(token.balanceOf(address(puller)), 3e6);
        assertEq(token.allowance(user, address(puller)), 5e6, "previous allowance restored");

        // A fresh approval granted by a plan does not outlive it either.
        vm.prank(user);
        token.approve(address(puller), 0);
        _exec(_one(approve));
        assertEq(token.allowance(user, address(puller)), 0);
    }

    // ---------------------------------------------------------------- wallet behaviour

    function test_signaturesFromTheOwnKeyAreValid() public view {
        bytes32 hash = keccak256("covenant");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, hash);
        assertEq(wallet.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));

        (v, r, s) = vm.sign(0xBEEF, hash);
        assertEq(wallet.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));

        // Malleable high-s twin of a valid signature is rejected.
        (v, r, s) = vm.sign(PK, hash);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        assertEq(wallet.isValidSignature(hash, abi.encodePacked(r, highS, flipped)), bytes4(0xffffffff));
    }

    function test_walletStillReceivesEthAndNfts() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = user.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(user.balance, 1 ether);
        assertEq(wallet.onERC721Received(address(0), address(0), 0, ""), bytes4(0x150b7a02));
        assertEq(wallet.onERC1155Received(address(0), address(0), 0, 0, ""), bytes4(0xf23a6e61));
        assertTrue(wallet.supportsInterface(0x150b7a02));
    }

    function test_ownerRecipientIsTheWalletItself() public {
        // transfer(to = owner) needs no recipient entry: the wallet is the owner.
        _exec(_two(_allot(address(token), 1e6), Plans.call(address(token), abi.encodeCall(IERC20.transfer, (user, 1e6)))));
        assertEq(token.balanceOf(user), 100e6);

        vm.expectRevert(abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, address(token), attacker));
        _exec(_two(_allot(address(token), 1e6), Plans.call(address(token), abi.encodeCall(IERC20.transfer, (attacker, 1e6)))));
    }
}
