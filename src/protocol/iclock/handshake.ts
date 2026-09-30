export function buildHandshake(sn: string): string {
  return [
    `GET OPTION FROM: ${sn}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=9999',
    'ErrorDelay=30',
    'Delay=10',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog EnrollUser ChgUser UserPic',
    'Realtime=1',
    'Encrypt=None',
  ].join('\n');
}
