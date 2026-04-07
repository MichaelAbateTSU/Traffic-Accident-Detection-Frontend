export const FIXED_CAMERA_STREAM_URLS = [
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_061/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_062/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_063/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_064/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_065/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_066/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_067/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_068/playlist.m3u8',
  'https://mcleansfs3.us-east-1.skyvdn.com/rtplive/R2_069/playlist.m3u8',
];

export const FIXED_MAX_FRAMES = 5;

export function getCameraIdFromStreamUrl(streamUrl) {
  const match = String(streamUrl).match(/\/(R2_\d+)\/playlist\.m3u8$/i);
  return match?.[1] ?? streamUrl;
}

export function getStreamUrlForCameraId(cameraId) {
  const normalizedId = String(cameraId);
  return FIXED_CAMERA_STREAM_URLS.find((streamUrl) => getCameraIdFromStreamUrl(streamUrl) === normalizedId) ?? null;
}
