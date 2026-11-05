The CLI fixture test assembles a pnpm installation using the existing TypeScript
fixture tool. The consumer resolves its sibling through ignored `dist/` output.
The test creates that output after committing base, then changes the consumer
and shared source. Base typechecking must use the tracked base source and classify
the consumer's introduced TS2322 as `new`, in working, staged and committed modes.
No dependency download or credentials are needed during the test.
