export const Liiquidate = [
    {
        "type":"function",
        "name":"previewProcessReport",
        "inputs":[
            {
                "name":"report",
                "type":"bytes",
                "internalType":"bytes"
            }
        ],
        "outputs":[
            {
                "name":"profit",
                "type":"uint256",
                "internalType":"uint256"
            }
        ],
        "stateMutability":"nonpayable"
    }
] as const
