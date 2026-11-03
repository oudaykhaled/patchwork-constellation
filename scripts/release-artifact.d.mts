export interface VerifiedRelease {
  id: string;
  commit: string;
  mode: string;
  files: number;
  thirdPartyNotices?: { sha256: string; packages: { name: string; version: string; declaredLicense: string }[] };
}
export function extractReleaseArchive(bytes: Buffer, directory: string): Promise<VerifiedRelease>;
