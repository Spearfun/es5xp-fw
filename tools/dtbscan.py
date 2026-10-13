# dtbscan.py - read only: finds flattened device trees inside the (decompressed) uImage of the stock kernel.
# Usage: python3 -I tools/dtbscan.py UIMAGE [DIR]   (DIR: write each tree found as DIR/dtb-<offset>.dtb)
import hashlib, lzma, os, struct, sys

def fdt_info(b, o):
    magic, total, off_st, off_str, off_rsv, ver, lastcomp, bootcpu, sz_str, sz_st = struct.unpack('>10I', b[o:o + 40])
    if not (16 <= ver <= 17 and 40 <= total <= len(b) - o and off_st < total and off_str < total):
        return None
    d = b[o:o + total]
    name = lambda i: d[off_str + i:d.index(b'\0', off_str + i)].decode('ascii', 'replace')
    p, depth, nodes, props, frag = off_st, 0, [], {}, 0
    while p + 4 <= off_st + sz_st:
        t = struct.unpack('>I', d[p:p + 4])[0]; p += 4
        if t == 1:
            e = d.index(b'\0', p); n = d[p:e].decode('ascii', 'replace'); p = (e + 4) & ~3
            depth += 1
            if depth == 2: nodes.append(n)
            if n.startswith('fragment@'): frag += 1
        elif t == 2: depth -= 1
        elif t == 3:
            ln, ni = struct.unpack('>II', d[p:p + 8]); v = d[p + 8:p + 8 + ln]; p = (p + 8 + ln + 3) & ~3
            if depth == 1 and name(ni) in ('model', 'compatible'):
                props[name(ni)] = v.rstrip(b'\0').replace(b'\0', b' | ').decode('ascii', 'replace')
        elif t == 4: pass
        elif t == 9: break
        else: return None
    return dict(total=total, ver=ver, props=props, nodes=nodes, frag=frag, blob=d)

def main():
    u = open(sys.argv[1], 'rb').read()
    magic, hcrc, tm, size, load, ep, dcrc, os_, arch, typ, comp = struct.unpack('>7I4B', u[:32])
    name = u[32:64].rstrip(b'\0').decode('ascii', 'replace')
    print('uImage magic %08x size %d load 0x%x entry 0x%x os %d arch %d type %d comp %d name "%s"' % (magic, size, load, ep, os_, arch, typ, comp, name))
    if magic != 0x27051956 or comp != 3: sys.exit('not an LZMA uImage')
    dec = lzma.LZMADecompressor(lzma.FORMAT_ALONE)
    k = dec.decompress(u[64:64 + size])
    print('kernel: %d bytes unpacked, sha256 %s' % (len(k), hashlib.sha256(k).hexdigest()))
    o = 0
    while True:
        o = k.find(b'\xd0\x0d\xfe\xed', o)
        if o < 0: break
        i = fdt_info(k, o)
        if i:
            print('FDT at 0x%x (%d): size %d (0x%x), version %d, %d top-level nodes, %d fragment@ nodes, sha256 %s' % (o, o, i['total'], i['total'], i['ver'], len(i['nodes']), i['frag'], hashlib.sha256(i['blob']).hexdigest()))
            for key, v in i['props'].items(): print('    %s = %s' % (key, v))
            print('    nodes: %s' % ' '.join(i['nodes'][:12]))
            if len(sys.argv) > 2:
                os.makedirs(sys.argv[2], exist_ok=True)
                open(os.path.join(sys.argv[2], 'dtb-%x.dtb' % o), 'wb').write(i['blob'])
        o += 4
main()
