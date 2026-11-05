# Synthetic unpacked OOXML fixture

This fixture contains no customer workbook data and does not invoke xlsx2py.
It represents a small, unpacked spreadsheet package with a malformed
`xl/workbook.xml` and a well-formed but invalid
`xl/_rels/workbook.xml.rels` relationship part.

`schemas/relationships-pilot.xsd` is a deliberately small test schema. It
checks required relationship attributes to prove local file-association based
validation. It is not the official or complete OOXML schema set.

The workspace config associates `.rels` files with this local schema. The
integration test repairs both parts, checks that the corrected relationship
part is clean, and verifies that LemMinX shuts down cleanly over its real
Windows stdio process.
