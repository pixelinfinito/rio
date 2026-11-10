import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

source = importlib.util.spec_from_file_location('archive', Path(__file__).resolve().parents[2] / 'crates/rio-qa/controller/src/seed-archive.py')
archive = importlib.util.module_from_spec(source)
source.loader.exec_module(archive)


class SeedArchiveTests(unittest.TestCase):
    def test_malformed_archives_never_modify_live_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live = root / 'uploads'
            live.mkdir()
            (live / 'retained').write_text('original')
            for variant in ('escape', 'symlink', 'hardlink', 'directory', 'collision', 'duplicate', 'expansion'):
                packed = root / 'archive.tar'
                with tarfile.open(packed, 'w:gz' if variant == 'expansion' else 'w') as output:
                    archive.member(output, 'manifest.json', json.dumps({'version': 1, 'directories': []}).encode())
                    if variant in ('symlink', 'hardlink', 'directory'):
                        member = tarfile.TarInfo('files/malicious')
                        member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'directory': tarfile.DIRTYPE}[variant]
                        member.linkname = '/etc/passwd'
                        output.addfile(member)
                    elif variant == 'escape':
                        archive.member(output, 'files/../escape', b'bad')
                    elif variant == 'collision':
                        archive.member(output, 'files/a', b'bad')
                        archive.member(output, 'files/a/b', b'bad')
                    elif variant == 'duplicate':
                        archive.member(output, 'files/a', b'bad')
                        archive.member(output, 'files/a', b'bad')
                    else:
                        archive.member(output, 'files/expanded', b'x' * 65536)
                with self.subTest(variant=variant), self.assertRaises(ValueError):
                    archive.restore(root, live, packed)
                self.assertEqual((live / 'retained').read_text(), 'original')
                self.assertEqual([path.name for path in live.iterdir()], ['retained'])
                self.assertFalse((root / 'escape').exists())


if __name__ == '__main__':
    unittest.main()
