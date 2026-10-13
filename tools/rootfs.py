#!/usr/bin/env python3
# rootfs.py - apply the es5xp changes described in rootfs/ to an unpacked stock root filesystem.
#   rootfs.py TREE BUILD_DIR VERSION STAMP BDATE
#     TREE       unpacked stock squashfs (changed in place)
#     BUILD_DIR  directory with the built programs (busybox, busybox.links, dropbear, swbatch)
#     VERSION    firmware version for lib/version, e.g. SW.ar7240.v2.4.1.30.261012.1200
#     STAMP      build marker for usr/etc/es5xp-build, e.g. "es5xp-1.0 20261012T120000Z"
#     BDATE      clock seed written into /init, YYYYMMDDhhmm (UTC)
# Every step checks its input: removed paths must exist and directories must become empty, patched files
# must have the listed sha256 before and after, ubntbox must be the stock one. The first error stops it.
import hashlib, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RF = os.path.join(ROOT, 'rootfs')
STOCK_VERSION = 'SW.ar7240.v2.4.1.7.260715.1150'


def die(msg):
    sys.exit('rootfs: ' + msg)


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def rows(name):
    """Non-empty, non-comment lines of a file in rootfs/, split into fields."""
    with open(os.path.join(RF, name)) as f:
        return [l.split() for l in f.read().split('\n') if l.strip() and not l.startswith('#')]


def clear(dst):
    """Remove a file or symlink that is about to be replaced; a directory is an error."""
    if os.path.lexists(dst):
        if os.path.isdir(dst) and not os.path.islink(dst):
            die('%s is a directory' % dst)
        os.unlink(dst)


def put(src, dst, mode):
    clear(dst)
    shutil.copyfile(src, dst)
    os.chmod(dst, mode)


def do_remove(tree):
    paths = [r[0] for r in rows('remove.txt')]
    for p in sorted(paths, key=lambda p: (-p.count('/'), p)):
        full = os.path.join(tree, p)
        if not os.path.lexists(full):
            die('remove: %s does not exist' % p)
        if os.path.isdir(full) and not os.path.islink(full):
            left = os.listdir(full)
            if left:
                die('remove: directory %s keeps unlisted entries: %s' % (p, ' '.join(sorted(left))))
            os.rmdir(full)
        else:
            os.unlink(full)
    print('removed %d paths' % len(paths))


def do_patch(tree, rel, bdate):
    table = {r[0]: r[1:] for r in rows('patches/patches.txt')}
    if rel not in table:
        die('patch: %s is not in patches.txt' % rel)
    name, sin, sout = table[rel]
    full = os.path.join(tree, rel)
    if sha(full) != sin:
        die('patch: %s is not the stock file (sha256 %s)' % (rel, sha(full)))
    with open(os.path.join(RF, 'patches', name), 'rb') as f:
        r = subprocess.run(['patch', '-d', tree, '-p1', '--fuzz=0', '--no-backup-if-mismatch', '-s'],
                           stdin=f, capture_output=True, text=True)
    if r.returncode != 0:
        die('patch %s failed: %s' % (name, (r.stdout + r.stderr).strip()))
    if sha(full) != sout:
        die('patch: %s after %s has sha256 %s, expected %s' % (rel, name, sha(full), sout))
    with open(full) as f:
        text = f.read()
    if '@BDATE@' in text:
        if text.count('BDATE=@BDATE@\n') != 1 or not re.fullmatch(r'\d{12}', bdate):
            die('patch: bad BDATE placeholder or value in %s' % rel)
        mode = os.stat(full).st_mode & 0o7777
        with open(full, 'w') as f:
            f.write(text.replace('BDATE=@BDATE@\n', 'BDATE=%s\n' % bdate))
        os.chmod(full, mode)


def do_bytes(tree, rel):
    full = os.path.join(tree, rel)
    sin = sout = None
    edits = []
    for r in rows('ubntbox.bytes'):
        if r[0] == 'sha256-in':
            sin = r[1]
        elif r[0] == 'sha256-out':
            sout = r[1]
        else:
            edits.append((int(r[0], 16), bytes.fromhex(r[1]), bytes.fromhex(r[2])))
    with open(full, 'rb') as f:
        data = bytearray(f.read())
    if hashlib.sha256(data).hexdigest() != sin:
        die('bytes: %s is not the stock file' % rel)
    for off, old, new in edits:
        if len(old) != len(new) or data[off:off + len(old)] != old:
            die('bytes: %s at %#x does not hold the expected bytes' % (rel, off))
        data[off:off + len(new)] = new
    if hashlib.sha256(data).hexdigest() != sout:
        die('bytes: %s after the edits has the wrong sha256' % rel)
    with open(full, 'r+b') as f:
        f.write(data)
    print('%s: %d edits' % (rel, len(edits)))


def check_links(tree, build):
    """Names of the symlinks to busybox must be the applets of busybox.links (wrappers keep a link in usr/libexec)."""
    have = set()
    for top, dirs, files in os.walk(tree):
        for n in dirs + files:
            p = os.path.join(top, n)
            if os.path.islink(p) and os.path.basename(os.readlink(p)) == 'busybox':
                have.add(n)
    with open(os.path.join(build, 'busybox.links')) as f:
        want = {os.path.basename(l.strip()) for l in f if l.strip()}
    if have != want:
        die('busybox links differ from busybox.links: missing %s, extra %s'
            % (' '.join(sorted(want - have)) or '-', ' '.join(sorted(have - want)) or '-'))
    print('busybox links: %d, as busybox.links' % len(have))


def main(av):
    if len(av) != 6:
        sys.exit('usage: rootfs.py TREE BUILD_DIR VERSION STAMP BDATE')
    tree, build, version, stamp, bdate = av[1:]
    with open(os.path.join(tree, 'lib/version')) as f:
        if f.read().strip() != STOCK_VERSION:
            die('%s is not the stock %s tree' % (tree, STOCK_VERSION))
    if not re.fullmatch(r'SW\.ar7240\.v2\.4\.1\.\d+\.\d{6}\.\d{4}', version):
        die('bad version %r' % version)
    if not re.fullmatch(r'\S+ \d{8}T\d{6}Z', stamp):
        die('bad stamp %r (the web reads its second field)' % stamp)
    do_remove(tree)
    n = 0
    for r in rows('install.txt'):
        op, args = r[0], r[1:]
        if op == 'mv':
            src, dst = (os.path.join(tree, a) for a in args)
            if not os.path.lexists(src) or os.path.lexists(dst):
                die('mv %s %s: source missing or target exists' % tuple(args))
            os.rename(src, dst)
        elif op == 'file':
            put(os.path.join(RF, 'files', args[1]), os.path.join(tree, args[1]), int(args[0], 8))
        elif op == 'built':
            put(os.path.join(build, args[2]), os.path.join(tree, args[1]), int(args[0], 8))
        elif op == 'dir':
            os.mkdir(os.path.join(tree, args[1]))
            os.chmod(os.path.join(tree, args[1]), int(args[0], 8))
        elif op == 'link':
            dst = os.path.join(tree, args[0])
            clear(dst)
            os.symlink(args[1], dst)
        elif op == 'patch':
            do_patch(tree, args[0], bdate)
        elif op == 'bytes':
            do_bytes(tree, args[0])
        elif op == 'text':
            value = {'VERSION': version, 'STAMP': stamp}[args[2]]
            dst = os.path.join(tree, args[1])
            clear(dst)
            with open(dst, 'w') as f:
                f.write(value + '\n')
            os.chmod(dst, int(args[0], 8))
        else:
            die('unknown operation %s' % op)
        n += 1
    print('applied %d operations' % n)
    check_links(tree, build)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
