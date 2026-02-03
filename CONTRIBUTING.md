# Contributing to Basilisk Escrow Contract

Thank you for your interest in contributing to the Basilisk Escrow Contract!

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR-USERNAME/basilisk-escrow-contract.git`
3. **Install** dependencies: `npm install`
4. **Build**: `anchor build`
5. **Test**: `anchor test`
6. Create a **branch**: `git checkout -b feature/your-feature`

## Prerequisites

- [Rust](https://rustup.rs/) (1.75+)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (1.18+)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (0.30.1)
- [Node.js](https://nodejs.org/) (18+)

## Development

```bash
# Install JS test dependencies
npm install

# Build the Solana program
anchor build

# Run the full test suite
anchor test

# Run tests against devnet
npm run test:devnet
```

## Code Style

### Rust
- Follow standard Rust formatting (`rustfmt`)
- Use explicit error types from `errors.rs` — no `unwrap()` in production code
- All arithmetic must use `checked_*` operations
- Document all public functions with `///` doc comments
- Keep instruction handlers focused and composable

### TypeScript (Tests)
- Use descriptive test names that explain the expected behavior
- Include both positive (happy path) and negative (security/error) tests
- Group tests by instruction using `describe` blocks

## Security Considerations

This is a financial smart contract. Extra care is required:

- **All account access must be validated** via PDA seeds and `has_one` constraints
- **Token accounts must validate both owner AND mint**
- **String inputs must be bounded** to prevent account overflow
- **Arithmetic must use `checked_*` operations** to prevent overflow
- **New instructions must include security tests** demonstrating unauthorized access is blocked

## Pull Request Process

1. Ensure `anchor build` compiles without errors
2. Ensure `anchor test` passes all 26+ tests
3. Add tests for any new instructions or modified behavior
4. Update `README.md` with details of new instructions or account changes
5. Update `SECURITY_AUDIT.md` if security-relevant changes are made
6. Write descriptive commit messages

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- Specify Anchor, Solana CLI, and Rust versions

## Security Vulnerabilities

If you discover a security vulnerability, **please report it privately** via GitHub Security Advisories rather than opening a public issue. Given this is a financial smart contract, responsible disclosure is critical.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
