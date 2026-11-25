# Security

Please report a vulnerability privately, through **Security › Report a vulnerability** on this repository's GitHub page, not in a public issue.

What DSHProxy does to protect your accounts and keys is described in the README, sections "Security" and (on a Mac) "What protects which secret". In short: the gateway listens on this computer only; saved API keys are encrypted with a key that Windows DPAPI or the macOS login Keychain protects for your account; sign-ins stay on your computer. Nothing is sent to the authors of DSHProxy.

Never paste API keys, sign-in links, tokens or account details into an issue or a pull request.
