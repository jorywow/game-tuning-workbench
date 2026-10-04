# Asset provider adapter contract

The plugin does not choose an image or model vendor in v0.1. Provider-specific code must implement `contracts/asset-provider.ts` and translate the normalized request into the vendor API.

## Required behavior

- Declare supported capabilities such as image generation, image editing, or 3D model generation.
- Validate requests before making an external call.
- Return a normalized asynchronous job state.
- Preserve provider job IDs without exposing credentials.
- Download results only after a job succeeds.
- Return output metadata needed to check the asset slot contract.

Provider adapters must not edit game source. They return generated candidates; a separate `replace-asset` ChangeSet performs the scoped replacement.

Replacing a candidate must validate relevant constraints such as dimensions, transparency, MIME type, model format, animation requirement, or polygon budget. If the candidate violates the slot contract, keep it as a preview and block application.

When the analyzed slot is `generated-runtime` and has no accepted file MIME types, the workbench may still request a standard PNG or GLB candidate, but the request must set `requiresRuntimeAdapter: true`. That candidate cannot replace a file directly; Codex must add a scoped runtime loading or conversion adapter and verify that the existing gameplay bindings remain intact.
