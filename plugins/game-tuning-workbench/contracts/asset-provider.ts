export type AssetCapability =
  | "image.generate"
  | "image.edit"
  | "model.generate";

export type AssetJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AssetProviderDescriptor {
  providerId: string;
  displayName: string;
  capabilities: AssetCapability[];
  acceptedReferenceMimeTypes: string[];
  outputMimeTypes: string[];
}

export interface AssetTechnicalConstraints {
  acceptedMimeTypes: string[];
  requiresRuntimeAdapter?: boolean;
  width?: number;
  height?: number;
  requiresTransparency?: boolean;
  modelFormats?: Array<"glb" | "gltf">;
  requiresAnimations?: boolean;
  maxPolygonCount?: number;
}

export interface AssetGenerationRequest {
  requestId: string;
  providerId: string;
  capability: AssetCapability;
  assetSlotId: string;
  prompt: string;
  negativePrompt?: string;
  referenceFiles: string[];
  constraints: AssetTechnicalConstraints;
}

export interface AssetOutput {
  outputId: string;
  localPath: string;
  mimeType: string;
  width?: number;
  height?: number;
  modelFormat?: "glb" | "gltf";
  polygonCount?: number;
  hasAnimations?: boolean;
}

export interface AssetJob {
  providerId: string;
  providerJobId: string;
  requestId: string;
  status: AssetJobStatus;
  progress?: number;
  outputs: AssetOutput[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface AssetProvider {
  describe(): Promise<AssetProviderDescriptor>;
  validate(request: AssetGenerationRequest): Promise<string[]>;
  submit(request: AssetGenerationRequest): Promise<AssetJob>;
  getJob(providerJobId: string): Promise<AssetJob>;
  cancel?(providerJobId: string): Promise<AssetJob>;
}
