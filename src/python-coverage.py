import ast
from typing import Any
"""Collect, validate and aggregate coverage.py data for project-checks."""

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

from coverage import Coverage, CoverageData


def validate(path):
    with path.open("rb") as source:
        if source.read(16) != b"SQLite format 3\0":
            raise ValueError("Invalid SQLite coverage contribution")
    data = CoverageData(basename=str(path))
    data.read()
    # A passing runner/configuration test can legitimately execute no app code.
    if not data.has_arcs() and data.measured_files():
        raise ValueError("Coverage contribution has no branch data")


def materialize(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staged = Path(temporary) / "data"
        shutil.copyfile(source, staged)
        validate(staged)
        os.replace(staged, destination)


def collect(directory, destination, config):
    coverage = Coverage(data_file=str(directory / "data"), config_file=str(config) if config else True)
    coverage.combine(data_paths=[str(directory)], strict=True)
    coverage.save()
    materialize(directory / "data", destination)


def aggregate(manifest, destination, config, root, minimum, report):
    files = json.loads(manifest.read_text())
    if not isinstance(files, list) or not files:
        raise ValueError("Every current file must supply coverage")
    coverage = Coverage(data_file=str(destination), config_file=str(config) if config else True)
    # Empty databases are valid no-op contributions; update combines all others.
    data = coverage.get_data()
    root_path = os.path.abspath(root)

    def map_path(name):
        # update also maps existing target tracer paths, so this must be
        # idempotent for absolute paths already inside the current root.
        mapped = os.path.abspath(os.path.join(root_path, name))
        if os.path.commonpath([root_path, mapped]) != root_path:
            raise ValueError(f"Covered source escapes its project root: {name}")
        return mapped

    for name in files:
        source = Path(name)
        validate(source)
        contribution = CoverageData(basename=str(source))
        contribution.read()
        for filename in contribution.measured_files():
            if os.path.isabs(filename):
                raise ValueError(f"Expected portable coverage source: {filename}")
            map_path(filename)
        data.update(contribution, map_path=map_path)
    coverage.save()
    coverage.report()
    report_file = str(destination) + ".json"
    coverage.json_report(outfile=report_file)
    results = json.loads(Path(report_file).read_text())
    totals = results["totals"]
    function_covered, function_total = function_totals(results["files"], root)
    actual = {
        "lines": percentage(totals["covered_lines"], totals["num_statements"]),
        "branches": percentage(totals["covered_branches"], totals["num_branches"]),
        "functions": percentage(function_covered, function_total),
    }
    if not results["files"]:
        raise ValueError("No source files in coverage domain")
    print("Python coverage: " + ", ".join(f"{name} {value:.2f}%" for name, value in actual.items()))
    if report:
        temporary = report.with_name(report.name + ".tmp")
        temporary.write_text(json.dumps({"actual": actual, "minimum": minimum}))
        os.replace(temporary, report)
    failures = [f"{name} {actual[name]:.2f}% < {floor:.2f}%" for name, floor in minimum.items() if actual[name] < floor]
    if failures:
        raise ValueError("Coverage below minimum: " + "; ".join(failures))


def percentage(covered: int, total: int) -> float:
    return 100.0 if total == 0 else covered * 100.0 / total


def executable_body_lines(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[int]:
    body = node.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    lines: set[int] = set()
    for statement in body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        lines.update(range(statement.lineno, statement.end_lineno + 1))
    return lines


def function_totals(files: dict[str, Any], root: Path) -> tuple[int, int]:
    covered = 0
    total = 0
    for filename, details in files.items():
        source = root / filename
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=filename)
        executed = set(details["executed_lines"])
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body_lines = executable_body_lines(node)
            if not body_lines:
                continue
            total += 1
            covered += bool(body_lines & executed)
    return covered, total


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["collect", "materialize", "aggregate"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--minimum", type=json.loads)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.operation == "materialize":
        materialize(args.source, args.destination)
    elif args.operation == "collect":
        collect(args.source, args.destination, args.config)
    else:
        aggregate(args.source, args.destination, args.config, args.root, args.minimum, args.report)
