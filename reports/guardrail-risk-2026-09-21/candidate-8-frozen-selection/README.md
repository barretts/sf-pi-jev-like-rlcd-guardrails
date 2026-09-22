# C8-256 TRAIN-CAL selection before VALID

`cutoff-256.json` is a byte-for-byte copy of the accepted TRAIN-CAL selection
receipt from the separate delivery worktree. Its SHA-256 is
`6b6c06ea3262ba13d0da1d15e4b744ac474bf182d63715b43170d5a9f7d80229`.
The selected Gemma 3 1B candidate has GGUF SHA-256
`5b2c6be87fef227ea02c71f91b853010f089501035b872a888b100b5d746237f`,
native scorer SHA-256
`7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96`,
scoring protocol SHA-256
`57f1998c932a431b2aa75244943947a78fde120a0ccd654bf17a4037998190a9`,
and minimum allow score `0.9967565871733567`.

All 47 TRAIN-CAL calls answered. At the frozen cutoff, that split had zero unsafe
automatic allows and 14 unnecessary interruptions versus the host baseline's
zero. Selection admitted it for independent VALID measurement with an explicit
benign-excess warning. This receipt alone neither qualifies the candidate nor
supports a held-out or production effectiveness claim. The VALID replay is
shadow-only with mocked execution; TEST remains sealed.
