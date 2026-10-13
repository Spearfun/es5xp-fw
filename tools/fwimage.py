#!/usr/bin/env python3
# fwimage.py - Ubiquiti EdgeSwitch ES-5XP firmware image (mkfwimage container) tool.
#   fwimage.py info    IMAGE                     print header, blocks, CRCs, kernel and squashfs details
#   fwimage.py extract IMAGE DIR                 verify IMAGE, write its parts into a new directory DIR
#   fwimage.py build   STOCK SQUASHFS VER OUT    STOCK with the squashfs replaced and version set to VER
#   fwimage.py check   STOCK IMAGE VER           IMAGE = STOCK except squashfs and version; every CRC valid
#
# Container layout (all integers big-endian, CRC = zlib CRC-32):
#   0x000  header  "UBNT" + version[256] + crc(bytes 0..259) + pad[4]       (268 bytes)
#   0x10c  blocks  "PART"/"EXEC" header (56 bytes) + data + crc(header+data) + pad[4]
#                  header: magic[4] name[16] pad[12] mem index base entry data_size part_size
#   last   "END." + crc(everything before "END.") + pad[4]
# ES-5XP v2.4.1 blocks: PART u-boot, PART kernel, PART rootfs, EXEC script (gzip tar with bin/preflash).
# The kernel uImage is cut at the 1 MiB kernel slot; its tail continues at the start of the rootfs
# PART, followed by zeros up to 0x180000, followed by the squashfs root filesystem.
import hashlib, io, os, re, signal, struct, sys, tarfile, zlib

HDR_LEN = 268
BLK_HDR = 56
SQ_OFF = 0x180000                 # squashfs offset inside the rootfs PART (flash 0x2d0000)
FLASH_BASE = 0x9f000000           # PART base addresses are CPU addresses of the NOR flash
EXPECT = [('PART', 'u-boot'), ('PART', 'kernel'), ('PART', 'rootfs'), ('EXEC', 'script')]
SQ_COMP = {1: 'gzip', 2: 'lzma', 3: 'lzo', 4: 'xz', 5: 'lz4', 6: 'zstd'}
UI_COMP = {0: 'none', 1: 'gzip', 2: 'bzip2', 3: 'lzma', 4: 'lzo', 5: 'lz4', 6: 'zstd'}


def crc(b):
    return zlib.crc32(b) & 0xffffffff


def u32(d, o):
    return struct.unpack_from('>I', d, o)[0]


def die(msg):
    sys.exit('fwimage: ' + msg)


def parse(d):
    """Return (version, blocks); each block is a dict. Exits on any format or CRC error."""
    if d[:4] != b'UBNT':
        die('no UBNT magic')
    if u32(d, 260) != crc(d[:260]):
        die('header CRC mismatch')
    raw = d[4:260]
    ver = raw.split(b'\0')[0]
    if raw[len(ver):].strip(b'\0'):
        die('version field has data after the NUL terminator')
    o, blocks = HDR_LEN, []
    while True:
        if o + 12 > len(d):
            die('truncated at %#x' % o)
        magic = d[o:o + 4]
        if magic == b'END.':
            if u32(d, o + 4) != crc(d[:o]):
                die('END. CRC mismatch')
            if len(d) != o + 12:
                die('%d bytes after END.' % (len(d) - o - 12))
            break
        if magic not in (b'PART', b'EXEC'):
            die('unknown block at %#x: %s' % (o, d[o:o + 16].hex()))
        name = d[o + 4:o + 20].split(b'\0')[0].decode('ascii', 'replace')
        mem, idx, base, entry, dsz, psz = struct.unpack_from('>6I', d, o + 32)
        end = o + BLK_HDR + dsz
        if end + 8 > len(d):
            die('block %s overruns the file' % name)
        if u32(d, end) != crc(d[o:end]):
            die('block %s CRC mismatch' % name)
        blocks.append(dict(kind=magic.decode(), name=name, off=o, mem=mem, idx=idx, base=base,
                           entry=entry, dsz=dsz, psz=psz, data=d[o + BLK_HDR:end]))
        o = end + 8
    if [(b['kind'], b['name']) for b in blocks] != EXPECT:
        die('unexpected block list: %s' % [(b['kind'], b['name']) for b in blocks])
    return ver.decode('ascii', 'replace'), blocks


def split_rootfs(blocks):
    """Return (uimage, squashfs) rebuilt from the kernel and rootfs PARTs. Exits if they do not add up."""
    k, r = blocks[1]['data'], blocks[2]['data']
    if u32(k, 0) != 0x27051956:
        die('kernel PART does not start with a uImage header')
    h = bytearray(k[:64])
    hcrc = u32(h, 4)
    struct.pack_into('>I', h, 4, 0)
    if crc(bytes(h)) != hcrc:
        die('uImage header CRC mismatch')
    total = 64 + u32(k, 12)
    tail = total - len(k)
    if not 0 <= tail <= SQ_OFF:
        die('uImage size %#x does not fit kernel PART + %#x' % (total, SQ_OFF))
    uimage = k + r[:tail]
    if crc(uimage[64:]) != u32(k, 24):
        die('uImage data CRC mismatch')
    if r[tail:SQ_OFF].strip(b'\0'):
        die('non-zero bytes between the kernel tail and the squashfs')
    sq = r[SQ_OFF:]
    if sq[:4] != b'hsqs':
        die('no squashfs magic at rootfs PART + %#x' % SQ_OFF)
    return uimage, sq


def sq_info(sq):
    inodes, mtime, bsize, frags, comp, blog, flags, ids, major, minor = struct.unpack_from('<IIIIHHHHHH', sq, 4)
    used = struct.unpack_from('<Q', sq, 40)[0]
    return dict(inodes=inodes, mtime=mtime, bsize=bsize, comp=SQ_COMP.get(comp, str(comp)),
                ver='%d.%d' % (major, minor), used=used)


def cmd_info(path):
    d = open(path, 'rb').read()
    ver, blocks = parse(d)
    print('image    %s  %d bytes' % (os.path.basename(path), len(d)))
    print('version  %s' % ver)
    print('%-8s %-8s %10s %10s %10s %10s  %s' % ('block', 'offset', 'data', 'slot', 'flash', 'crc', ''))
    for b in blocks:
        flash = '-' if b['kind'] == 'EXEC' else '%#x' % (b['base'] - FLASH_BASE)
        slot = '-' if b['kind'] == 'EXEC' else '%#x' % b['psz']
        print('%-8s %#-8x %#10x %10s %10s %10s  ok' % (b['name'], b['off'], b['dsz'], slot, flash,
                                                     '%08x' % crc(d[b['off']:b['off'] + BLK_HDR + b['dsz']])))
    print('END.     %#x  crc %08x ok' % (len(d) - 12, u32(d, len(d) - 8)))
    uimage, sq = split_rootfs(blocks)
    k = blocks[1]['data']
    print('uImage   %d bytes = kernel PART %#x + rootfs PART head %#x, then zeros to %#x; crc ok'
          % (len(uimage), len(k), len(uimage) - len(k), SQ_OFF))
    print('         "%s", %s, load %#x, entry %#x, time %d'
          % (k[32:64].split(b'\0')[0].decode('ascii', 'replace'), UI_COMP.get(k[31], str(k[31])),
             u32(k, 16), u32(k, 20), u32(k, 8)))
    s = sq_info(sq)
    print('squashfs %d bytes at rootfs PART + %#x (flash %#x), bytes_used %d, v%s, %s, block %d, inodes %d, mkfs_time %d'
          % (len(sq), SQ_OFF, blocks[2]['base'] - FLASH_BASE + SQ_OFF, s['used'], s['ver'], s['comp'],
             s['bsize'], s['inodes'], s['mtime']))
    print('         slot for squashfs %#x, free %d bytes' % (blocks[2]['psz'] - SQ_OFF, blocks[2]['psz'] - SQ_OFF - len(sq)))
    with tarfile.open(fileobj=io.BytesIO(blocks[3]['data']), mode='r:gz') as t:
        print('script   %s' % ', '.join('%s (%d)' % (m.name, m.size) for m in t.getmembers()))
    return 0


def cmd_extract(path, outdir):
    d = open(path, 'rb').read()
    ver, blocks = parse(d)
    uimage, sq = split_rootfs(blocks)
    if os.path.lexists(outdir):
        die('%s already exists (extraction always starts clean)' % outdir)
    os.makedirs(outdir)
    files = [('version.txt', (ver + '\n').encode()), ('u-boot.bin', blocks[0]['data']),
             ('kernel-part.bin', blocks[1]['data']), ('rootfs-part.bin', blocks[2]['data']),
             ('script.tar.gz', blocks[3]['data']), ('uImage', uimage), ('rootfs.sqsh', sq)]
    for name, data in files:
        with open(os.path.join(outdir, name), 'wb') as f:
            f.write(data)
        print('%-16s %9d  %s' % (name, len(data), hashlib.sha256(data).hexdigest()))
    return 0


def vprefix(v):
    """The part of the version that bin/preflash parses: '%[^v]v%d.%d.%d'."""
    m = re.match(r'([^v]*v\d+\.\d+\.\d+)', v)
    return m.group(1) if m else None


def cmd_build(stock, sqpath, ver, out):
    d = bytearray(open(stock, 'rb').read())
    sver, blocks = parse(bytes(d))
    split_rootfs(blocks)
    sq = open(sqpath, 'rb').read()
    if sq[:4] != b'hsqs':
        die('%s is not a squashfs image' % sqpath)
    if vprefix(ver) is None or vprefix(ver) != vprefix(sver):
        die('version %r must keep the stock prefix %r (parsed by bin/preflash)' % (ver, vprefix(sver)))
    if len(ver.encode()) > 255:
        die('version too long')
    d[4:260] = ver.encode().ljust(256, b'\0')
    struct.pack_into('>I', d, 260, crc(bytes(d[:260])))
    r = blocks[2]
    newdata = r['data'][:SQ_OFF] + sq
    if len(newdata) > r['psz']:
        die('squashfs %d bytes exceeds its slot by %d bytes' % (len(sq), len(newdata) - r['psz']))
    hdr = bytearray(d[r['off']:r['off'] + BLK_HDR])
    struct.pack_into('>I', hdr, 48, len(newdata))
    rend = r['off'] + BLK_HDR + r['dsz']
    end_off = len(d) - 12
    o = bytearray(d[:r['off']])
    o += hdr + newdata + struct.pack('>I', crc(bytes(hdr) + newdata)) + d[rend + 4:rend + 8]
    o += d[rend + 8:end_off]
    o += b'END.' + struct.pack('>I', crc(bytes(o))) + d[end_off + 8:]
    with open(out, 'wb') as f:
        f.write(o)
    print('built %s: %d bytes, version %s, squashfs %d bytes, free %d' % (out, len(o), ver, len(sq), r['psz'] - len(newdata)))
    return cmd_check(stock, out, ver)


def cmd_check(stock, path, ver):
    a, b = open(stock, 'rb').read(), open(path, 'rb').read()
    va, ba = parse(a)
    vb, bb = parse(b)
    split_rootfs(ba)
    split_rootfs(bb)
    bad = []
    if vb != ver:
        bad.append('version %s, expected %s' % (vb, ver))
    if vprefix(vb) != vprefix(va):
        bad.append('version prefix %r differs from stock %r' % (vprefix(vb), vprefix(va)))
    if a[264:268] != b[264:268]:
        bad.append('header pad differs')
    for x, y in zip(ba, bb):
        keys = ('kind', 'name', 'mem', 'idx', 'base', 'entry', 'psz')
        if any(x[k] != y[k] for k in keys):
            bad.append('block %s: header fields differ' % y['name'])
        if y['name'] == 'rootfs':
            same = x['data'][:SQ_OFF] == y['data'][:SQ_OFF]
            state = 'kernel tail same, squashfs %s' % ('same' if x['data'] == y['data'] else 'replaced')
            if not same:
                bad.append('rootfs PART: first %#x bytes (kernel tail) differ' % SQ_OFF)
        else:
            same = x['data'] == y['data']
            state = 'same as stock' if same else 'DIFFERS'
            if not same:
                bad.append('block %s differs from stock' % y['name'])
        print('%-8s crc ok, %s' % (y['name'], state))
    print('version  %s -> %s' % (va, vb))
    for m in bad:
        print('BAD: ' + m)
    return 1 if bad else 0


def main(av):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)   # quiet exit when piped into head
    cmds = {'info': (cmd_info, 1), 'extract': (cmd_extract, 2), 'build': (cmd_build, 4), 'check': (cmd_check, 3)}
    if len(av) < 2 or av[1] not in cmds or len(av) - 2 != cmds[av[1]][1]:
        sys.exit('usage: fwimage.py info IMAGE | extract IMAGE DIR | build STOCK SQUASHFS VER OUT | check STOCK IMAGE VER')
    fn, _ = cmds[av[1]]
    return fn(*av[2:])


if __name__ == '__main__':
    sys.exit(main(sys.argv))
