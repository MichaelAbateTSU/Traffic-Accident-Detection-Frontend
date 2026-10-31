export function cameraJobStatusLabel(status) {
  if (status === 'online') return 'Job pending/running';
  if (status === 'offline') return 'Job complete';
  if (status === 'warning') return 'Job failed';
  return 'Job state unknown';
}
