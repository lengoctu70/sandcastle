# Publish the fork as `@lengoctu70/sandcastle`

## Context

The upstream package is published as `@ai-hero/sandcastle`. This fork changes the installation experience and public behavior for non-code users, so publishing it under the upstream owner's npm scope is neither available nor an honest statement of ownership. An npm package name becomes part of generated imports, installation instructions, scripts, and upgrade paths, making it expensive to change after users adopt it.

## Decision

Publish the fork under the owner's npm scope as `@lengoctu70/sandcastle`. Keep the executable name `sandcastle`, so the primary setup flow is:

```bash
npm install --save-dev @lengoctu70/sandcastle
npx @lengoctu70/sandcastle init
```

Generated imports and commands must refer to `@lengoctu70/sandcastle`, not the upstream package.

## Consequences

- Users can distinguish the fork from upstream and install it from an npm scope controlled by the fork owner.
- Existing upstream examples cannot be copied unchanged when they contain the package import path.
- Pulling future upstream changes requires consciously preserving the fork's package identity and generated paths.
- The npm account `lengoctu70` must remain able to publish the scoped package. At decision time the account is authenticated on the design machine and the public package name is unclaimed.
