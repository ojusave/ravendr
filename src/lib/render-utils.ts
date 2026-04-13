export function renderSignupUrlWithUtms(
  content: string = "footer_link"
): string {
  const params = new URLSearchParams({
    utm_source: "github",
    utm_medium: "referral",
    utm_campaign: "ojus_demos",
    utm_content: content,
  });
  return `https://render.com/register?${params.toString()}`;
}

export const GITHUB_REPO = "https://github.com/ojusave/ravendr";

export function deployToRenderUrl(): string {
  return `https://render.com/deploy?repo=${encodeURIComponent(GITHUB_REPO)}`;
}
