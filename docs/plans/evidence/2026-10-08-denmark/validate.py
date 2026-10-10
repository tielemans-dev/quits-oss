"""Check the preserved XML against the pinned CIUS archive, including expected failures.

Usage: python validate.py /path/to/cius.zip
Requires saxonche==13.0.0. Extracts only the three XSLTs into an owned TemporaryDirectory.
"""
import hashlib
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

from saxonche import PySaxonProcessor

EXPECTED_SHA256 = "1e7d01804fcc8e2f1e3464201566a589d5e5c7b24f1362971539b4d0699ab9ba"
XSLTS = ["CEN-EN16931-UBL.xslt", "PEPPOL-EN16931-UBL.xslt", "DK-EN16931-UBL.xslt"]
EXPECTED = {
    "dk-b2b-invoice": [[], [], []],
    "dk-public-gln-invoice": [[], [], []],
    "dk-b2b-credit-note": [[], [], []],
    "legacy-fixture-dk-to-de": [[], [], []],
    "negative-control": [[], ["DK-R-005"], []],
    "negative-control-2": [["BR-06"], ["PEPPOL-EN16931-R003", "DK-R-002"], []],
}

archive = Path(sys.argv[1])
if hashlib.sha256(archive.read_bytes()).hexdigest() != EXPECTED_SHA256:
    sys.exit("Refused: CIUS archive SHA-256 differs from the researched version")

with tempfile.TemporaryDirectory(prefix="denmark-cius-") as temp, zipfile.ZipFile(archive) as bundle, PySaxonProcessor(license=False) as proc:
    processor = proc.new_xslt30_processor()
    stylesheets = []
    for name in XSLTS:
        path = Path(temp) / name
        # Exact member names only; never extract untrusted archive paths.
        path.write_bytes(bundle.read("Schematron/" + name))
        stylesheets.append(processor.compile_stylesheet(stylesheet_file=str(path)))
    print(proc.version)
    mismatch = False
    for name, expected in EXPECTED.items():
        doc = proc.parse_xml(xml_file_name=str(Path(__file__).parent / "xml" / (name + ".xml")))
        for stylesheet, executable, wanted in zip(XSLTS, stylesheets, expected):
            result = ET.fromstring(executable.transform_to_string(xdm_node=doc))
            if result.tag != "{http://purl.oclc.org/dsdl/svrl}schematron-output":
                sys.exit("Refused: validator did not produce SVRL")
            assertions = result.findall(".//{http://purl.oclc.org/dsdl/svrl}failed-assert")
            failures = sorted((node.attrib.get("id"), node.attrib.get("flag")) for node in assertions)
            passed = failures == sorted((rule, "fatal") for rule in wanted)
            mismatch |= not passed
            print(f"{name} / {stylesheet}: {failures or 'no failures'}; expected {'PASS' if passed else 'FAIL'}")
    sys.exit(1 if mismatch else 0)
