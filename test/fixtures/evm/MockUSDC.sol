// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// Local testing only. Never deploy this token as a payment asset in production.
contract MockUSDC {
    string public constant name = "USDC";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    function mint(address to, uint256 value) external { balanceOf[to] += value; }
    function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization expired");
        require(!authorizationState[from][nonce], "authorization is used");
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256(bytes(name)),keccak256(bytes(version)),block.chainid,address(this)));
        bytes32 body = keccak256(abi.encode(keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),from,to,value,validAfter,validBefore,nonce));
        require(ecrecover(keccak256(abi.encodePacked("\x19\x01",domain,body)),v,r,s) == from && from != address(0), "invalid signature");
        require(balanceOf[from] >= value, "insufficient balance");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit AuthorizationUsed(from,nonce);
        emit Transfer(from,to,value);
    }
}
