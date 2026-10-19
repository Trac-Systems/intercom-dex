import b4a from 'b4a';

export function peerPresent(sidechannel, channel, peerKey) {
  if (!/^intercom-dex:t:[0-9a-f]{64}$/.test(channel) || !/^[0-9a-f]{64}$/.test(peerKey)) throw new Error('Invalid peer presence query.');
  return [...sidechannel.connections].some(([connection, channels]) => connection.remotePublicKey &&
    b4a.toString(connection.remotePublicKey, 'hex') === peerKey && channels.get(channel)?.channel?.opened === true);
}
