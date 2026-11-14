import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { osmTile, project } from '@gutad/shared';

export interface Dot { id: string; lat: number; lng: number; color: string; size?: number; label?: string }

/** Read-only map on OpenStreetMap tiles with coloured dots (couriers, pickups, drop-offs, zone corners). */
export function TileMap({ center, zoom = 13, height = 260, dots = [] }: { center: { lat: number; lng: number }; zoom?: number; height?: number; dots?: Dot[] }) {
  const [width, setWidth] = useState(0);
  const c = project(center.lat, center.lng, zoom);
  const left = c.x - width / 2, top = c.y - height / 2;
  const n = 2 ** zoom;
  const tiles: { x: number; y: number }[] = [];
  if (width) for (let tx = Math.floor(left / 256); tx <= Math.floor((left + width) / 256); tx++) for (let ty = Math.floor(top / 256); ty <= Math.floor((top + height) / 256); ty++) if (ty >= 0 && ty < n) tiles.push({ x: tx, y: ty });
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height, overflow: 'hidden', borderRadius: 12, backgroundColor: '#efeae4', marginBottom: 10 }}>
      {tiles.map((t) => <Image key={`${t.x}/${t.y}`} source={{ uri: osmTile(((t.x % n) + n) % n, t.y, zoom) }} style={{ position: 'absolute', left: t.x * 256 - left, top: t.y * 256 - top, width: 256, height: 256 }} />)}
      {width > 0 && dots.map((d) => { const p = project(d.lat, d.lng, zoom); const s = d.size || 10; return (
        <View key={d.id} style={{ position: 'absolute', left: p.x - left - s / 2, top: p.y - top - s / 2, flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: s, height: s, borderRadius: s / 2, backgroundColor: d.color, borderWidth: 2, borderColor: '#fff' }} />
          {d.label ? <Text style={{ fontSize: 10, marginLeft: 3, backgroundColor: 'rgba(255,255,255,0.8)' }}>{d.label}</Text> : null}
        </View>
      ); })}
      <Text style={{ position: 'absolute', right: 2, bottom: 2, fontSize: 9, backgroundColor: 'rgba(255,255,255,0.8)' }}>© OpenStreetMap contributors</Text>
    </View>
  );
}
