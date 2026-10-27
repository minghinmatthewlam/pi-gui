export interface AugmentPosixPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly delimiter?: string;
  readonly exists?: (dir: string) => boolean;
}

export interface AugmentPosixPathResult {
  readonly changed: boolean;
  readonly path: string;
}

export function augmentPosixPath(options?: AugmentPosixPathOptions): AugmentPosixPathResult;
