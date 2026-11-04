"""Workspace capability discovery and in-process loading."""

import ast
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys


EXCLUDED = {"logs", ".ludens", ".git", "node_modules", ".venv", "venv", "__pycache__"}


def annotation_schema(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        node = ast.parse(node.value, mode="eval").body
    if isinstance(node, ast.Constant) and node.value is None:
        return {"type": "null"}
    if isinstance(node, ast.Name) and node.id in {"str", "int", "float", "bool"}:
        return {"type": {"str": "string", "int": "integer", "float": "number", "bool": "boolean"}[node.id]}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = annotation_schema(node.left), annotation_schema(node.right)
        if (left == {"type": "null"}) == (right == {"type": "null"}):
            raise ValueError("Only T | None unions are supported")
        return {"anyOf": [left, right]}
    if isinstance(node, ast.Subscript):
        name = node.value.id if isinstance(node.value, ast.Name) else None
        if isinstance(node.value, ast.Attribute) and isinstance(node.value.value, ast.Name) and node.value.value.id == "typing":
            name = node.value.attr
        item = node.slice
        if name in {"list", "List"}:
            return {"type": "array", "items": annotation_schema(item)}
        if name in {"dict", "Dict"} and isinstance(item, ast.Tuple) and len(item.elts) == 2:
            if annotation_schema(item.elts[0]) != {"type": "string"}:
                raise ValueError("Dictionary keys must be str")
            return {"type": "object", "additionalProperties": annotation_schema(item.elts[1])}
        if name == "Optional":
            return {"anyOf": [annotation_schema(item), {"type": "null"}]}
    raise ValueError("Unsupported annotation; use str, int, float, bool, list[T], dict[str, T], or Optional[T]/T | None")


def validate(value, schema, location="arguments"):
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                validate(value, branch, location)
                return
            except ValueError:
                pass
        raise ValueError(location + " does not match its optional type")
    kind = schema["type"]
    matches = {
        "null": value is None,
        "string": isinstance(value, str),
        "integer": type(value) is int,
        "number": type(value) in (int, float) and (not isinstance(value, float) or math.isfinite(value)),
        "boolean": type(value) is bool,
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    if not matches[kind]:
        raise ValueError(location + " must be " + kind)
    if kind == "array":
        for index, item in enumerate(value):
            validate(item, schema["items"], "%s[%d]" % (location, index))
    if kind == "object":
        if any(not isinstance(key, str) for key in value):
            raise ValueError(location + " must have string keys")
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise ValueError(location + "." + name + " is required")
        for name, item in value.items():
            child_schema = properties.get(name, schema.get("additionalProperties"))
            if not child_schema:
                raise ValueError(location + "." + name + " is not a declared parameter")
            validate(item, child_schema, location + "." + name)


def function_schema(node):
    if isinstance(node, ast.AsyncFunctionDef):
        raise ValueError("Async capabilities are unsupported by the CLI; use a synchronous function")
    if node.args.posonlyargs or node.args.vararg or node.args.kwarg:
        raise ValueError("Positional-only parameters, *args and **kwargs are unsupported")
    description = ast.get_docstring(node)
    if not description or not description.strip():
        raise ValueError("A capability must have a docstring describing its use")
    args = node.args.args + node.args.kwonlyargs
    defaults = [None] * (len(node.args.args) - len(node.args.defaults)) + node.args.defaults + node.args.kw_defaults
    properties, required = {}, []
    for argument, default in zip(args, defaults):
        if argument.annotation is None:
            raise ValueError("Parameter %s requires a supported type annotation" % argument.arg)
        schema = annotation_schema(argument.annotation)
        if default is None:
            required.append(argument.arg)
        else:
            try:
                value = ast.literal_eval(default)
                # Reject non-JSON literals before they can silently change shape.
                validate(value, schema, "Default for " + argument.arg)
                json.dumps(value, allow_nan=False)
            except (ValueError, TypeError) as error:
                raise ValueError("Parameter %s requires a JSON literal default matching its annotation: %s" % (argument.arg, error))
            schema = {**schema, "default": value}
        properties[argument.arg] = schema
    return description, {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def marked_declarations(tree, marker_name="capability"):
    """Match ludens_tools decorators on functions and classes at any depth."""
    names = (marker_name,) if isinstance(marker_name, str) else tuple(marker_name)
    decorators, modules = set(), set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "ludens_tools":
            decorators.update(alias.asname or alias.name for alias in node.names if alias.name in names)
        if isinstance(node, ast.Import):
            modules.update(alias.asname or alias.name for alias in node.names if alias.name == "ludens_tools")
    def is_marker(node):
        if isinstance(node, ast.Call):
            node = node.func
        return (isinstance(node, ast.Name) and node.id in decorators) or (
            isinstance(node, ast.Attribute) and node.attr in names and isinstance(node.value, ast.Name) and node.value.id in modules)
    return [(node, [item for item in node.decorator_list if is_marker(item)])
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and any(is_marker(item) for item in node.decorator_list)]


def marked_functions(tree, marker_name="capability"):
    return [(node, markers) for node, markers in marked_declarations(tree, marker_name)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]


def workspace_sources(workspace, diagnostics):
    """Read ordinary workspace sources without importing or following links."""
    workspace = Path(workspace).resolve()
    for directory, folders, files in os.walk(workspace, followlinks=False):
        folders[:] = sorted(folder for folder in folders if folder not in EXCLUDED)
        for filename in sorted(files):
            if not filename.endswith(".py"):
                continue
            source = Path(directory) / filename
            relative = source.relative_to(workspace).as_posix()
            raw = None
            try:
                source.resolve().relative_to(workspace)
                raw = source.read_bytes()
                tree = ast.parse(raw, filename=relative)
            except (OSError, SyntaxError, ValueError) as error:
                # A broken ordinary helper is not itself an exposed capability.
                if raw is None or b"ludens_tools" in raw:
                    diagnostics.append({"path": relative, "line": getattr(error, "lineno", None), "message": str(error)})
                continue
            yield relative, raw, tree


def _eval_declaration(node, markers, tree, relative):
    """Validate one @eval_capability function locally; return (description, target, env_target)."""
    if len(markers) != 1:
        raise ValueError("Use eval_capability once on each eval function")
    marker = markers[0]
    if not isinstance(marker, ast.Call):
        raise ValueError("eval_capability must be called with its target capability")
    malformed = ValueError("@eval_capability requires a capability function or 'python/path.py:name' target, "
                           "and an optional env=@eval_env or 'python/path.py:EnvName'")
    env_expr = None
    if not marker.args:
        raise malformed
    if len(marker.args) > 2:
        raise malformed
    if len(marker.args) == 2:
        env_expr = marker.args[1]
    for keyword in marker.keywords:
        if keyword.arg != "env" or env_expr is not None:
            raise malformed
        env_expr = keyword.value
    if isinstance(node, ast.AsyncFunctionDef):
        raise ValueError("Async eval functions are unsupported; use a synchronous function")
    if node not in tree.body:
        raise ValueError("Eval functions must be top-level functions, not methods or nested functions")
    description = ast.get_docstring(node)
    if not description or not description.strip():
        raise ValueError("An eval function must have a docstring describing its rewards")
    arguments = node.args
    if arguments.posonlyargs or arguments.vararg or arguments.kwarg:
        raise ValueError("Positional-only parameters, *args and **kwargs are unsupported")
    for argument, default in zip(arguments.args, [None] * (len(arguments.args) - len(arguments.defaults)) + list(arguments.defaults)):
        if default is None:
            raise ValueError("Eval functions take no required parameters; give every parameter a literal default")
        try:
            ast.literal_eval(default)
        except (ValueError, TypeError):
            raise ValueError("Eval function parameters require literal defaults") from None
    for default in arguments.kw_defaults:
        if default is None:
            raise ValueError("Eval functions take no required parameters; give every parameter a literal default")
        try:
            ast.literal_eval(default)
        except (ValueError, TypeError):
            raise ValueError("Eval function parameters require literal defaults") from None
    target = marker.args[0]
    if isinstance(target, ast.Constant) and isinstance(target.value, str) and target.value.strip():
        resolved_target = target.value
    elif isinstance(target, ast.Name):
        resolved_target = "python/" + relative + ":" + target.id
    else:
        raise ValueError("eval_capability requires a @capability function name or a 'python/<path.py>:<function>' ID string")
    env_target = None
    if env_expr is not None:
        if isinstance(env_expr, ast.Name):
            env_target = "python/" + relative + ":" + env_expr.id
        elif isinstance(env_expr, ast.Constant) and isinstance(env_expr.value, str) and env_expr.value.startswith("python/"):
            env_target = env_expr.value
        else:
            raise malformed
    return description, resolved_target, env_target


def discover(workspace):
    capabilities, diagnostics, pending, envs = [], [], [], []
    observe_declarations = []  # (relative, node, qualname) in discovery order
    observe_capability = None
    for relative, raw, tree in workspace_sources(workspace, diagnostics):
        declarations = {}
        for kind in ("capability", "record", "observe"):
            for node, markers in marked_functions(tree, kind):
                declarations.setdefault(node, {})[kind] = markers
        evals = {node: markers for node, markers in marked_functions(tree, ("eval_capability", "eval"))}
        code_sha = hashlib.sha256(raw).hexdigest()
        for node, markers in marked_declarations(tree, "eval_env"):
            def report(message, node=node):
                diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": message})
            if node in declarations or node in evals:
                report("eval_env cannot be combined with capability, record, observe, or eval_capability decorators")
                continue
            if len(markers) != 1:
                report("Use eval_env once on each declaration")
                continue
            marker = markers[0]
            if isinstance(marker, ast.Call):
                if marker.args or marker.keywords:
                    report("@eval_env does not take arguments")
                    continue
            if node not in tree.body or not isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                report("@eval_env is only supported on top-level classes or synchronous functions")
                continue
            doc = ast.get_docstring(node)
            if not doc or not doc.strip():
                report("@eval_env requires a docstring")
                continue
            envs.append({"id": f"python/{relative}:{node.name}", "name": node.name, "description": doc,
                         "origin": {"path": relative, "function": node.name, "line": node.lineno}, "codeSHA": code_sha})
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        combined = {node for node in evals if node in declarations}
        for node in combined:
            diagnostics.append({"path": relative, "function": node.name, "line": node.lineno,
                                "message": "eval_capability cannot be combined with capability or record decorators"})
        for node, markers in evals.items():
            if node in combined:
                continue
            try:
                description, target, env_target = _eval_declaration(node, markers, tree, relative)
                pending.append({"path": relative, "function": node.name, "line": node.lineno,
                                "codeSHA": code_sha, "description": description,
                                "target": target, "env_target": env_target})
            except ValueError as error:
                diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": str(error)})
        for node, kinds in declarations.items():
            if node in combined:
                continue
            try:
                markers = [marker for items in kinds.values() for marker in items]
                if any(len(items) != 1 for items in kinds.values()) or len(markers) != len(node.decorator_list):
                    raise ValueError("Use capability, record, and observe decorators once each; other decorators are unsupported")
                if "record" in kinds and "capability" not in kinds:
                    raise ValueError("@record requires @capability on the same function")
                if "observe" in kinds and "capability" not in kinds:
                    raise ValueError("@observe requires @capability on the same function")
                for marker in markers:
                    if isinstance(marker, ast.Call) and (marker.args or marker.keywords):
                        raise ValueError("Use capability/record/observe without decorator arguments")
                if node not in tree.body:
                    if isinstance(parents.get(node), ast.ClassDef):
                        # Bound capability methods (including resident entry points)
                        # are instrumented locally, never exposed as CLI functions.
                        if "observe" in kinds:
                            parent = parents[node]
                            observe_declarations.append((relative, node, f"{parent.name}.{node.name}"))
                        continue
                    raise ValueError("CLI capabilities must be top-level functions, not methods or nested functions")
                if sum(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.name == node.name for item in tree.body) != 1:
                    raise ValueError("A capability function name must be unique within its source file")
                description, parameters = function_schema(node)
                identity = relative + ":" + node.name
                name = re.sub(r"[^a-zA-Z0-9_]", "_", "python_" + relative[:-3] + "_" + node.name)[:53]
                name += "_" + hashlib.sha256(identity.encode()).hexdigest()[:10]
                if "observe" in kinds:
                    observe_declarations.append((relative, node, node.name))
                capabilities.append({"id": name, "name": name, "description": description, "parameters": parameters,
                    "origin": {"path": relative, "function": node.name, "line": node.lineno}, "codeSHA": hashlib.sha256(raw).hexdigest(),
                    "recorded": "record" in kinds, "observe": "observe" in kinds, "eval": None})
            except (ValueError, SyntaxError) as error:
                diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": str(error)})
    # @observe marks the workspace's single observation channel across files.
    for relative, node, qualname in observe_declarations:
        if len(observe_declarations) == 1:
            observe_capability = "python/" + relative + ":" + qualname
            continue
        diagnostics.append({"path": relative, "function": node.name, "line": node.lineno,
                            "message": "Only one @observe capability may be declared in a workspace"})
        for entry in capabilities:
            if entry["origin"]["path"] == relative and entry["origin"]["function"] == node.name:
                entry["observe"] = False
        observe_capability = None
    # Eval targets and env bindings may reference declarations in any file.
    indexed = {"python/" + item["origin"]["path"] + ":" + item["origin"]["function"]: item for item in capabilities}
    env_by_id = {item["id"]: item for item in envs}
    for declaration in pending:
        capability = indexed.get(declaration["target"])
        if capability is None:
            diagnostics.append({"path": declaration["path"], "function": declaration["function"], "line": declaration["line"],
                                "message": "Eval target " + declaration["target"] + " is not a discovered workspace capability"})
            continue
        if capability["eval"] is not None:
            diagnostics.append({"path": declaration["path"], "function": declaration["function"], "line": declaration["line"],
                                "message": "Capability " + declaration["target"] + " already has eval " + capability["eval"]["id"]})
            continue
        env_binding = None
        if declaration["env_target"] is not None:
            env_entry = env_by_id.get(declaration["env_target"])
            if env_entry is None:
                diagnostics.append({"path": declaration["path"], "function": declaration["function"], "line": declaration["line"],
                                    "message": "@eval_capability env " + declaration["env_target"] + " does not match a discovered @eval_env"})
                continue
            env_binding = {"id": env_entry["id"], "origin": env_entry["origin"],
                           "codeSHA": env_entry["codeSHA"], "description": env_entry["description"]}
        capability["eval"] = {"id": "python/" + declaration["path"] + ":" + declaration["function"],
                              "origin": {"path": declaration["path"], "function": declaration["function"], "line": declaration["line"]},
                              "codeSHA": declaration["codeSHA"], "description": declaration["description"], "env": env_binding}
    envs.sort(key=lambda item: item["id"])
    return {"capabilities": capabilities, "envs": envs, "diagnostics": diagnostics, "observeCapability": observe_capability}


def _load_marked(workspace, relative_path, function_name, marker_attribute, unmarked, *, raw=None):
    """Load a marked function once, sharing ordinary Python imports by file."""
    workspace = Path(workspace).resolve()
    source = (workspace / relative_path).resolve()
    source.relative_to(workspace)

    def imported_module():
        for module in tuple(sys.modules.values()):
            filename = getattr(module, "__file__", None)
            if filename and Path(filename).resolve() == source:
                return module
        return None

    module = imported_module()
    if module is None:
        for entry in (str(workspace), str(source.parent)):
            if entry not in sys.path:
                sys.path.insert(0, entry)
        parts = source.relative_to(workspace).with_suffix("").parts
        module_name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
        if not module_name or not all(part.isidentifier() for part in module_name.split(".")) or module_name in sys.modules:
            module_name = "_ludens_workspace_" + hashlib.sha256(str(source).encode()).hexdigest()[:16]
        parent_name, _, child_name = module_name.rpartition(".")
        parent = importlib.import_module(parent_name) if parent_name else None
        # A package's __init__ may itself import the selected module.
        module = imported_module()
        if module is None:
            raw = source.read_bytes() if raw is None else raw
            spec = importlib.util.spec_from_file_location(module_name, source)
            module = importlib.util.module_from_spec(spec)
            module.__ludens_source_sha__ = hashlib.sha256(raw).hexdigest()
            module.__ludens_source_bytes__ = raw
            sys.modules[module_name] = module
            try:
                exec(compile(raw, str(source), "exec"), module.__dict__)
            except BaseException:
                del sys.modules[module_name]
                raise
            if parent is not None:
                setattr(parent, child_name, module)
    function = getattr(module, function_name)
    if not callable(function) or not getattr(function, marker_attribute, False):
        raise ValueError(unmarked)
    return function


def load_function(workspace, relative_path, function_name, *, raw=None):
    return _load_marked(workspace, relative_path, function_name, "__ludens_capability__",
                        "The selected function is not marked @capability", raw=raw)


def load_eval_function(workspace, relative_path, function_name, *, raw=None):
    return _load_marked(workspace, relative_path, function_name, "__ludens_eval__",
                        "The selected function is not marked @eval_capability", raw=raw)


def call_local(workspace, capability_id, arguments):
    """Call a workspace function in this process, preserving Python objects."""
    relative_path, separator, function_name = capability_id.removeprefix("python/").rpartition(":")
    if not capability_id.startswith("python/") or not separator or not relative_path.endswith(".py") or not function_name.isidentifier():
        raise ValueError("Python capability IDs use python/path.py:function")
    return load_function(workspace, relative_path, function_name)(**arguments)
