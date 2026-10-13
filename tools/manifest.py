#!/usr/bin/env python3
# manifest.py - list a root tree, or diff two root trees (no symlink following).
#   manifest.py list TREE        one line per entry
#   manifest.py diff BASE NEW    added / removed / changed entries + summary
# Entry: type mode uid:gid size digest path
#   type: f file, d dir, l symlink, c/b device, p fifo, s socket
#   digest: sha256 for files, "-> target" for symlinks, "major,minor" for devices, "-" otherwise
# mtime is ignored on purpose (build timestamps differ). Run as root to read every file.
import hashlib, os, signal, stat, sys

KIND = ((stat.S_ISREG, 'f'), (stat.S_ISDIR, 'd'), (stat.S_ISLNK, 'l'), (stat.S_ISCHR, 'c'),
        (stat.S_ISBLK, 'b'), (stat.S_ISFIFO, 'p'), (stat.S_ISSOCK, 's'))


def entry(full):
    st = os.lstat(full)
    kind = next(k for test, k in KIND if test(st.st_mode))
    size, digest = '-', '-'
    if kind == 'f':
        h = hashlib.sha256()
        with open(full, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b''):
                h.update(chunk)
        size, digest = str(st.st_size), h.hexdigest()
    elif kind == 'l':
        digest = '-> ' + os.readlink(full)
    elif kind in 'cb':
        digest = '%d,%d' % (os.major(st.st_rdev), os.minor(st.st_rdev))
    return (kind, '%04o' % stat.S_IMODE(st.st_mode), '%d:%d' % (st.st_uid, st.st_gid), size, digest)


def scan(root):
    if not os.path.isdir(root):
        sys.exit('not a directory: ' + root)
    out = {}
    for top, dirs, files in os.walk(root):
        dirs.sort()
        for name in dirs + sorted(files):
            full = os.path.join(top, name)
            out[os.path.relpath(full, root)] = entry(full)
    return out


def fmt(path, e):
    return '%s %s %s %s %s %s' % (e[0], e[1], e[2], e[3], e[4], path)


def main(av):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)   # quiet exit when piped into head
    if len(av) == 3 and av[1] == 'list':
        for p, e in sorted(scan(av[2]).items()):
            print(fmt(p, e))
        return 0
    if len(av) != 4 or av[1] != 'diff':
        sys.exit(__doc__ or 'usage: manifest.py list TREE | diff BASE NEW')
    a, b = scan(av[2]), scan(av[3])
    added = sorted(set(b) - set(a))
    removed = sorted(set(a) - set(b))
    common = sorted(set(a) & set(b))
    content = [p for p in common if a[p][0] != b[p][0] or a[p][4] != b[p][4]]
    meta = [p for p in common if p not in content and (a[p][1:3] != b[p][1:3])]
    print('# base %s: %d entries; new %s: %d entries' % (av[2], len(a), av[3], len(b)))
    print('# added %d, removed %d, content changed %d, mode/owner changed %d, unchanged %d'
          % (len(added), len(removed), len(content), len(meta), len(common) - len(content) - len(meta)))
    for title, paths, src in (('ADDED', added, b), ('REMOVED', removed, a)):
        print('\n## %s (%d)' % (title, len(paths)))
        for p in paths:
            print(fmt(p, src[p]))
    print('\n## CHANGED (%d)' % (len(content) + len(meta)))
    for p in sorted(content + meta):
        print('- ' + fmt(p, a[p]))
        print('+ ' + fmt(p, b[p]))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
