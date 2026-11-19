import ast
from typing import Any
"""Collect, validate and aggregate coverage.py data for project-checks."""

import argparse
import hashlib
import io
from importlib.machinery import BuiltinImporter, FileFinder, FrozenImporter, PathFinder, SourceFileLoader
import json
import os
from pathlib import Path
from pkgutil import get_importer
import shutil
import tempfile
import sys


def validate(path):
    from coverage import CoverageData

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
    from coverage import Coverage

    coverage = Coverage(data_file=str(directory / "data"), config_file=str(config) if config else True)
    coverage.combine(data_paths=[str(directory)], strict=True)
    coverage.save()
    materialize(directory / "data", destination)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def provider_files(spec):
    try:
        from importlib._bootstrap_external import _get_supported_file_loaders

        # A custom finder could redirect the package or just its reporting modules.
        distutils = getattr(sys.modules.get("_distutils_hack"), "DISTUTILS_FINDER", None)
        standard_finders = {id(finder) for finder in (BuiltinImporter, FrozenImporter, PathFinder, distutils)}
        if any(id(finder) not in standard_finders for finder in sys.meta_path):
            return None
        if not spec or type(spec.loader) is not SourceFileLoader or not spec.origin:
            return None
        origin = Path(spec.origin).resolve()
        package = origin.parent
        if Path(spec.loader.path).resolve() != origin or [Path(p).resolve() for p in spec.submodule_search_locations or ()] != [package]:
            return None
        # CPython checks source mtime and size before accepting timestamp-based bytecode.
        files = {str(p.relative_to(package)): (file_hash(p), p.stat().st_mtime_ns if p.suffix == ".py" else None)
                 for p in package.rglob("*")
                 if p.suffix in {".py", ".pyc", ".so", ".pyd"} and p.is_file()}
        loaders = [(suffix, loader) for loader, suffixes in _get_supported_file_loaders() for suffix in suffixes]
        directories = {(package / name).parent for name in files if "__pycache__" not in Path(name).parts}
        for directory in directories | {package}:
            finder = get_importer(str(directory))
            if (type(finder) is not FileFinder or Path(finder.path).resolve() != directory
                    or finder._loaders != loaders):
                return None
        return fingerprint([str(origin), files]) if files else None
    except (AttributeError, ImportError, OSError, TypeError, ValueError):
        return None


def domain_proof(coverage, config, root, provider_at_load):
    # Only plain, local Python domains have a reproducible report inventory.
    # Plugins, remapped paths, and unrecognized provider APIs use native reporting.
    try:
        import coverage as provider
        from coverage.files import GlobMatcher, find_python_files, prep_patterns

        if (not provider_at_load or provider_files(provider.__spec__) != provider_at_load
                or Path(provider.__file__).resolve() != Path(provider.__spec__.origin).resolve()
                or [Path(p).resolve() for p in provider.__path__] != [Path(provider.__file__).resolve().parent]
                or coverage.get_option("run:debug") or os.getenv("COVERAGE_FORCE_CONFIG")
                or coverage.config.config_files_read != [str(config)]):
            return None, set()
        effective = dict(coverage.config.debug_info())
        del effective["data_file"]  # The runner supplies a unique staging database for each run.

        sources = coverage.get_option("run:source")
        if (not sources or coverage.get_option("run:plugins") or coverage.get_option("paths")
                or getattr(coverage.config, "source_pkgs", None) or getattr(coverage.config, "source_dirs", None)
                or coverage.get_option("report:include") or coverage.get_option("report:omit")):
            return None, set()
        omit = coverage.get_option("run:omit")
        omit = GlobMatcher(prep_patterns(omit), "omit") if omit else None
        files = {}
        for source in sources:
            location = root / source
            if not location.is_dir():
                if not source.isidentifier():
                    return None, set()
                spec = PathFinder.find_spec(source, [str(root), *sys.path])
                if not spec or not spec.origin or not spec.origin.endswith(".py"):
                    return None, set()
                location = Path(spec.origin)
                if spec.submodule_search_locations is not None:
                    location = location.parent
            location = location.resolve()
            if not location.is_relative_to(root):
                return None, set()
            candidates = find_python_files(str(location), coverage.config.include_namespace_packages) if location.is_dir() else [str(location)]
            for name in candidates:
                path = Path(name).resolve()
                if not path.is_relative_to(root):
                    return None, set()
                if not omit or not omit.match(str(path)):
                    files[str(path.relative_to(root))] = file_hash(path)
        identity = fingerprint([str(root), sys.path, sys.version, str(sys.flags), sys.executable,
                                file_hash(Path(sys.executable)), provider.__version__, provider_at_load, effective,
                                str(config), file_hash(config), file_hash(Path(__file__)), dict(os.environ), files])
        return identity, set(files)
    except (AttributeError, ImportError, KeyError, OSError, TypeError, ValueError):
        return None, set()


def saved_measurement(previous, basis, domain, minimum):
    try:
        saved = json.loads(previous.read_text())
        reuse = saved["reuse"]
        # The Node summary writer serializes whole-valued floats as JSON integers.
        if not isinstance(reuse["output"], str) or not isinstance(saved["actual"], dict) or set(saved["actual"]) != set(minimum):
            return None
        if any(type(value) not in (int, float) for value in saved["actual"].values()):
            return None
        actual = {name: float(saved["actual"][name]) for name in minimum}
        if any(not 0 <= value <= 100 for value in actual.values()):
            return None
        if (reuse["domain"] == domain and saved["minimum"] == minimum
                and reuse["key"] == fingerprint([basis, domain, minimum, actual, reuse["output"]])):
            return {"actual": actual, "minimum": minimum, "reuse": reuse}
    except (KeyError, OSError, OverflowError, TypeError, ValueError):
        pass
    return None


def aggregate(manifest, destination, config, root, minimum, report, basis=None, previous=None, provider_at_load=None):
    from coverage import Coverage, CoverageData

    files = json.loads(manifest.read_text())
    if not isinstance(files, list) or not files:
        raise ValueError("Every current file must supply coverage")
    coverage = Coverage(data_file=str(destination), config_file=str(config) if config else True)
    domain, expected = domain_proof(coverage, config, root, provider_at_load) if basis else (None, set())
    measurement = saved_measurement(previous, basis, domain, minimum) if domain else None
    if measurement:
        print(measurement["reuse"]["output"], end="")
        finish(measurement, report)
        return
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
    output = io.StringIO() if domain else None
    coverage.report(file=output)
    if output is not None:
        print(output.getvalue(), end="")
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
    measurement = {"actual": actual, "minimum": minimum}
    if domain and expected and expected == set(results["files"]):
        text = output.getvalue()
        measurement["reuse"] = {"domain": domain, "output": text,
                                "key": fingerprint([basis, domain, minimum, actual, text])}
    finish(measurement, report)


def finish(measurement, report):
    actual, minimum = measurement["actual"], measurement["minimum"]
    print("Python coverage: " + ", ".join(f"{name} {value:.2f}%" for name, value in actual.items()))
    if report:
        temporary = report.with_name(report.name + ".tmp")
        temporary.write_text(json.dumps(measurement))
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
    parser.add_argument("operation", choices=["collect", "materialize", "aggregate", "verify"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--minimum", type=json.loads)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--basis")
    args = parser.parse_args()
    # Snapshot the provider before Python imports its implementation.
    check_provider = args.basis or args.operation == "verify"
    before_import = None
    if check_provider and "coverage" not in sys.modules and sys.pycache_prefix is None:
        # Reading a cold installation must not change its bytecode fingerprint.
        sys.dont_write_bytecode = True
        before_import = provider_files(PathFinder.find_spec("coverage", sys.path))
    if args.operation == "materialize":
        materialize(args.source, args.destination)
    elif args.operation == "collect":
        collect(args.source, args.destination, args.config)
    elif args.operation == "verify":
        from coverage import Coverage

        coverage = Coverage(data_file=str(args.destination), config_file=str(args.config))
        if domain_proof(coverage, args.config, args.root, before_import)[0] != json.loads(args.source.read_text())["reuse"]["domain"]:
            raise ValueError("Python coverage domain changed during verification")
    else:
        aggregate(args.source, args.destination, args.config, args.root, args.minimum, args.report, args.basis, args.previous, before_import)
