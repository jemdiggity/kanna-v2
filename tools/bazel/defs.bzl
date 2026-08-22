TauriBundleInfo = provider(
    doc = "Normalized Tauri bundle inputs for one target triple.",
    fields = {
        "bundle_inputs_dir": "Directory containing normalized bundle inputs.",
        "bundle_manifest": "Manifest describing staged inputs and destinations.",
        "main_binary": "Main application binary file.",
        "sidecars": "List of staged sidecar files.",
        "bundle_id": "Bundle identifier.",
        "product_name": "Product name.",
        "version": "Application version.",
        "target_triple": "Target triple for this bundle.",
        "info_plist": "Generated Info.plist file.",
        "entitlements": "Optional entitlements file.",
        "main_binary_name": "Basename used for the main app executable.",
    },
)

MacosAppBundleInfo = provider(
    doc = "Unsigned macOS app bundle output.",
    fields = {
        "app_bundle": "Directory representing the unsigned .app bundle.",
        "bundle_id": "Bundle identifier.",
        "product_name": "Product name.",
        "version": "Application version.",
        "target_triple": "Target triple for this app bundle.",
        "info_plist": "Final Info.plist file.",
        "manifest": "Bundle manifest file.",
    },
)

def _normalize_parts(parts, absolute_behavior):
    normalized = []
    for part in parts:
        if part in ["", "."]:
            continue
        if part == "..":
            normalized.append("_up_")
            continue
        normalized.append(part)

    if absolute_behavior and normalized:
        return [absolute_behavior] + normalized
    return normalized

def _normalize_resource_relpath(path):
    absolute_behavior = None
    if path.startswith("/"):
        absolute_behavior = "_root_"
    return "/".join(_normalize_parts(path.split("/"), absolute_behavior))

def _normalize_bundle_relative_path(path):
    return "/".join(_normalize_parts(path.split("/"), None))

def _strip_target_triple_suffix(path, target_triple):
    filename = path.split("/")[-1]
    suffix = "-%s" % target_triple
    if filename.endswith(suffix):
        return filename[:-len(suffix)]
    return filename

def _parse_icon_position(name, coords):
    parts = coords.split(",")
    if len(parts) != 2:
        fail("icon_positions[%s] must be formatted as x,y" % name)

    x = parts[0].strip()
    y = parts[1].strip()
    if x == "" or y == "":
        fail("icon_positions[%s] must be formatted as x,y" % name)

    x_value = _parse_int_string("icon_positions", name, x)
    y_value = _parse_int_string("icon_positions", name, y)
    return "%s:%s,%s" % (name, x_value, y_value)

def _parse_int_string(field_name, key, value):
    if value == "":
        fail("%s[%s] must be an integer" % (field_name, key))

    start = 0
    first = value[0]
    if first in ["+", "-"]:
        if len(value) == 1:
            fail("%s[%s] must be an integer" % (field_name, key))
        start = 1

    for i in range(start, len(value)):
        if value[i] not in "0123456789":
            fail("%s[%s] must be an integer" % (field_name, key))

    return int(value)

def _format_window_coords(name, values):
    if len(values) != 2:
        fail("%s must contain exactly two integers" % name)
    return ",".join([str(value) for value in values])

def _default_plist_inputs(bundle_id, product_name, version, main_binary_name):
    return {
        "bundle_id": bundle_id,
        "product_name": product_name,
        "version": version,
        "main_binary_name": main_binary_name,
    }

def _manifest_entry(source, destination, kind):
    return {
        "source": source,
        "destination": destination,
        "kind": kind,
    }

def _encode_manifest(entries, metadata):
    sorted_entries = sorted(entries, key = lambda entry: entry["destination"])
    return json.encode({
        "metadata": metadata,
        "entries": sorted_entries,
    })

def _files_from_target(target):
    return target[DefaultInfo].files.to_list()

def _files_from_targets(targets):
    files = []
    for target in targets:
        files.extend(_files_from_target(target))
    return files

def _single_file_from_target(target, attr_name):
    files = _files_from_target(target)
    if len(files) != 1:
        fail("%s must provide exactly one file, got %d" % (attr_name, len(files)))
    return files[0]

def _label_keyed_entries(label_dict, kind):
    entries = []
    inputs = []
    for target, destination in label_dict.items():
        file = _single_file_from_target(target, kind)
        entries.append((file, destination))
        inputs.append(file)
    return entries, inputs

def _label_keyed_tree_entries(label_dict):
    entries = []
    inputs = []
    for target, destination_prefix in label_dict.items():
        for file in _files_from_target(target):
            entries.append((file, destination_prefix))
            inputs.append(file)
    return entries, inputs

def _tauri_bundle_inputs_impl(ctx):
    has_version = ctx.attr.version != ""
    has_version_file = ctx.file.version_file != None
    if has_version == has_version_file:
        fail("exactly one of version or version_file must be set")

    main_binary = ctx.file.main_binary
    main_binary_name = main_binary.basename
    version_value = ctx.attr.version if has_version else "<from VERSION file>"

    info_plist = ctx.actions.declare_file(ctx.label.name + "_Info.plist")
    bundle_manifest = ctx.actions.declare_file(ctx.label.name + "_bundle_manifest.json")
    bundle_inputs_dir = ctx.actions.declare_directory(ctx.label.name + "_bundle_inputs")
    spec_file = ctx.actions.declare_file(ctx.label.name + "_bundle_spec.json")

    frontend_files = _files_from_target(ctx.attr.frontend_dist) if ctx.attr.frontend_dist else []
    sidecar_files = _files_from_targets(ctx.attr.sidecars)
    resource_files = _files_from_targets(ctx.attr.resources)
    icon_files = _files_from_targets(ctx.attr.icons)
    capability_files = _files_from_targets(ctx.attr.capabilities)
    framework_files = _files_from_targets(ctx.attr.frameworks)
    plist_fragment_files = _files_from_targets(ctx.attr.info_plist_fragments)
    resource_map_entries, mapped_resource_inputs = _label_keyed_entries(ctx.attr.resource_map, "resource_map")
    resource_tree_entries, resource_tree_inputs = _label_keyed_tree_entries(ctx.attr.resource_trees)
    macos_file_entries, macos_file_inputs = _label_keyed_entries(ctx.attr.macos_files, "macos_files")

    plist_inputs = [ctx.executable._make_plist_tool]
    plist_arguments = ctx.actions.args()
    plist_arguments.add("--output", info_plist.path)
    plist_arguments.add("--bundle-id", ctx.attr.bundle_id)
    plist_arguments.add("--product-name", ctx.attr.product_name)
    plist_arguments.add("--main-binary-name", main_binary_name)
    if has_version:
        plist_arguments.add("--version", ctx.attr.version)
    else:
        plist_inputs.append(ctx.file.version_file)
        plist_arguments.add("--version-file", ctx.file.version_file.path)
    if ctx.file.tauri_config:
        plist_inputs.append(ctx.file.tauri_config)
        plist_arguments.add("--tauri-config", ctx.file.tauri_config.path)
    if icon_files:
        plist_arguments.add("--icon-name", icon_files[0].basename)
    for fragment in plist_fragment_files:
        plist_inputs.append(fragment)
        plist_arguments.add("--plist-fragment", fragment.path)

    ctx.actions.run(
        executable = ctx.executable._make_plist_tool,
        inputs = plist_inputs,
        outputs = [info_plist],
        arguments = [plist_arguments],
        mnemonic = "TauriMakePlist",
        progress_message = "Generating Info.plist for %s" % ctx.label.name,
    )

    entries = []
    manifest_inputs = [main_binary, info_plist]
    if ctx.file.tauri_config:
        manifest_inputs.append(ctx.file.tauri_config)
    if ctx.file.entitlements:
        manifest_inputs.append(ctx.file.entitlements)
        entries.append(_manifest_entry(
            ctx.file.entitlements.path,
            "Contents/Resources/tauri/entitlements.plist",
            "entitlements",
        ))

    entries.append(_manifest_entry(
        info_plist.path,
        "Contents/Info.plist",
        "info_plist",
    ))
    entries.append(_manifest_entry(
        main_binary.path,
        "Contents/MacOS/%s" % main_binary_name,
        "main_binary",
    ))

    for file in frontend_files:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/frontend/%s" % _normalize_resource_relpath(file.short_path),
            "frontend_dist",
        ))

    for file in resource_files:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/resources/%s" % _normalize_resource_relpath(file.short_path),
            "resource",
        ))

    for file, destination in resource_map_entries:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/%s" % _normalize_bundle_relative_path(destination),
            "mapped_resource",
        ))

    for file, destination_prefix in resource_tree_entries:
        manifest_inputs.append(file)
        destination = _normalize_resource_relpath(file.short_path)
        if destination_prefix:
            destination = "%s/%s" % (
                _normalize_bundle_relative_path(destination_prefix),
                destination,
            )
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/%s" % destination,
            "resource_tree",
        ))

    for file in icon_files:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/%s" % file.basename,
            "icon",
        ))

    for file in capability_files:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Resources/tauri/capabilities/%s" % file.basename,
            "capability",
        ))

    for file in framework_files:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/Frameworks/%s" % file.basename,
            "framework",
        ))

    for file in sidecar_files:
        expected_suffix = "-%s" % ctx.attr.target_triple
        if not file.basename.endswith(expected_suffix):
            fail("sidecar %s must end with %s" % (file.basename, expected_suffix))
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/MacOS/%s" % _strip_target_triple_suffix(file.path, ctx.attr.target_triple),
            "sidecar",
        ))

    for file, destination in macos_file_entries:
        manifest_inputs.append(file)
        entries.append(_manifest_entry(
            file.path,
            "Contents/%s" % _normalize_bundle_relative_path(destination),
            "macos_file",
        ))

    metadata = _default_plist_inputs(
        bundle_id = ctx.attr.bundle_id,
        product_name = ctx.attr.product_name,
        version = version_value,
        main_binary_name = main_binary_name,
    )
    metadata["target_triple"] = ctx.attr.target_triple
    metadata["entry_count"] = len(entries)

    ctx.actions.write(
        output = spec_file,
        content = _encode_manifest(entries, metadata),
    )

    manifest_run_inputs = depset(
        direct = manifest_inputs + mapped_resource_inputs + resource_tree_inputs + macos_file_inputs + [spec_file, ctx.executable._make_manifest_tool],
    )
    manifest_arguments = ctx.actions.args()
    manifest_arguments.add("--spec", spec_file.path)
    manifest_arguments.add("--output-dir", bundle_inputs_dir.path)
    manifest_arguments.add("--output-manifest", bundle_manifest.path)
    ctx.actions.run(
        executable = ctx.executable._make_manifest_tool,
        inputs = manifest_run_inputs,
        outputs = [bundle_inputs_dir, bundle_manifest],
        arguments = [manifest_arguments],
        mnemonic = "TauriStageBundleInputs",
        progress_message = "Staging Tauri bundle inputs for %s" % ctx.label.name,
    )

    return [
        DefaultInfo(files = depset([bundle_inputs_dir, bundle_manifest, info_plist])),
        TauriBundleInfo(
            bundle_inputs_dir = bundle_inputs_dir,
            bundle_manifest = bundle_manifest,
            main_binary = main_binary,
            sidecars = sidecar_files,
            bundle_id = ctx.attr.bundle_id,
            product_name = ctx.attr.product_name,
            version = version_value,
            target_triple = ctx.attr.target_triple,
            info_plist = info_plist,
            entitlements = ctx.file.entitlements,
            main_binary_name = main_binary_name,
        ),
    ]

def _tauri_macos_app_impl(ctx):
    bundle = ctx.attr.bundle[TauriBundleInfo]
    app_bundle = ctx.actions.declare_directory("%s.app" % ctx.label.name)
    app_manifest = ctx.actions.declare_file("%s_app_manifest.json" % ctx.label.name)

    ctx.actions.run_shell(
        inputs = [bundle.bundle_inputs_dir, bundle.bundle_manifest],
        outputs = [app_bundle, app_manifest],
        command = """
set -eu
mkdir -p "$1"
cp -R "$2"/Contents "$1/Contents"
cp "$3" "$4"
""",
        arguments = [
            app_bundle.path,
            bundle.bundle_inputs_dir.path,
            bundle.bundle_manifest.path,
            app_manifest.path,
        ],
        mnemonic = "TauriAssembleMacosApp",
        progress_message = "Assembling macOS app bundle for %s" % ctx.label.name,
    )

    return [
        DefaultInfo(files = depset([app_bundle, app_manifest])),
        MacosAppBundleInfo(
            app_bundle = app_bundle,
            bundle_id = bundle.bundle_id,
            product_name = bundle.product_name,
            version = bundle.version,
            target_triple = bundle.target_triple,
            info_plist = bundle.info_plist,
            manifest = app_manifest,
        ),
    ]

tauri_bundle_inputs = rule(
    implementation = _tauri_bundle_inputs_impl,
    attrs = {
        "frontend_dist": attr.label(allow_files = True),
        "main_binary": attr.label(allow_single_file = True, mandatory = True),
        "sidecars": attr.label_list(allow_files = True),
        "resources": attr.label_list(allow_files = True),
        "resource_map": attr.label_keyed_string_dict(allow_files = True),
        "resource_trees": attr.label_keyed_string_dict(allow_files = True),
        "icons": attr.label_list(allow_files = True),
        "tauri_config": attr.label(allow_single_file = True),
        "capabilities": attr.label_list(allow_files = True),
        "entitlements": attr.label(allow_single_file = True),
        "info_plist_fragments": attr.label_list(allow_files = True),
        "macos_files": attr.label_keyed_string_dict(allow_files = True),
        "bundle_id": attr.string(mandatory = True),
        "product_name": attr.string(mandatory = True),
        "version": attr.string(),
        "version_file": attr.label(allow_single_file = True),
        "target_triple": attr.string(mandatory = True),
        "frameworks": attr.label_list(allow_files = True),
        "_make_manifest_tool": attr.label(
            default = "//tools/bazel:make_tauri_manifest.py",
            executable = True,
            allow_single_file = True,
            cfg = "exec",
        ),
        "_make_plist_tool": attr.label(
            default = "@rules_tauri//tools:make_plist.py",
            executable = True,
            allow_single_file = True,
            cfg = "exec",
        ),
    },
)

tauri_macos_app = rule(
    implementation = _tauri_macos_app_impl,
    attrs = {
        "bundle": attr.label(mandatory = True),
    },
)

def _target_platform_transition_impl(settings, attr):
    return {
        "//command_line_option:platforms": str(attr.platform),
    }

target_platform_transition = transition(
    implementation = _target_platform_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)

def _exec_target_impl(ctx):
    return [DefaultInfo(files = ctx.attr.target[DefaultInfo].files)]

exec_target = rule(
    implementation = _exec_target_impl,
    attrs = {
        "target": attr.label(mandatory = True, cfg = "exec"),
    },
)

def _single_output(target, attr_name):
    files = target[DefaultInfo].files.to_list()
    if len(files) != 1:
        fail("%s must provide exactly one output, got %d" % (attr_name, len(files)))
    return files[0]

def _find_named_file(files, basename, attr_name):
    matches = [file for file in files if file.basename == basename]
    if len(matches) != 1:
        fail("%s must provide exactly one %s, got %d" % (attr_name, basename, len(matches)))
    return matches[0]

def _target_files(targets):
    files = []
    for target in targets:
        files.extend(target[DefaultInfo].files.to_list())
    return files

def _cargo_src_relpath(file, package):
    if not package:
        return file.short_path

    prefix = package + "/"
    if file.short_path.startswith(prefix):
        return file.short_path[len(prefix):]

    return file.short_path

def _cargo_src_manifest(ctx, name):
    manifest = ctx.actions.declare_file(name)
    lines = []
    for file in ctx.files.cargo_srcs:
        lines.append("%s\t%s" % (file.path, _cargo_src_relpath(file, ctx.label.package)))
    ctx.actions.write(manifest, "\n".join(lines) + "\n")
    return manifest

def _run_tauri_tool_with_staged_config(ctx, *, tool, config, other_inputs, outputs, args, mnemonic, progress_message):
    manifest = _cargo_src_manifest(ctx, ctx.label.name + "_cargo_srcs_manifest.txt")

    ctx.actions.run_shell(
        inputs = depset(direct = ctx.files.cargo_srcs + other_inputs + [config, manifest, tool]),
        outputs = outputs,
        arguments = [tool.path, manifest.path, config.path, args],
        command = """
set -euo pipefail
tool="$1"
manifest="$2"
config="$3"
shift 3

staged="$(mktemp -d "${TMPDIR:-/tmp}/kanna-tauri-config.XXXXXX")"
cleanup() {
  rm -rf "$staged"
}
trap cleanup EXIT

python3 - "$manifest" "$staged" "$config" <<'PY'
import pathlib
import shutil
import sys

manifest_path = pathlib.Path(sys.argv[1])
staged_dir = pathlib.Path(sys.argv[2])
config_path = pathlib.Path(sys.argv[3])

for raw_line in manifest_path.read_text(encoding="utf-8").splitlines():
    if not raw_line:
        continue
    src_raw, rel_raw = raw_line.split("\t", 1)
    src = pathlib.Path(src_raw)
    rel = pathlib.Path(rel_raw)
    destination = staged_dir / rel
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, destination)

destination = staged_dir / "tauri.conf.json"
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(config_path, destination)
PY

"$tool" --config "$staged/tauri.conf.json" "$@"
""",
        mnemonic = mnemonic,
        progress_message = progress_message,
    )

def _tauri_acl_prep_dir_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name + ".out_dir")
    config = _single_output(ctx.attr.config, "config") if ctx.attr.config else _find_named_file(ctx.files.cargo_srcs, "tauri.conf.json", "cargo_srcs")
    frontend_dist = _single_output(ctx.attr.frontend_dist, "frontend_dist")
    dep_target_files = _target_files(ctx.attr.dep_env_targets)
    dep_env_files = [file for file in dep_target_files if file.basename.endswith(".depenv")]
    dep_out_dirs = [file for file in dep_target_files if file.is_directory]

    args = ctx.actions.args()
    for dep_env_file in dep_env_files:
        args.add("--dep-env-file", dep_env_file.path)
    for dep_out_dir in dep_out_dirs:
        args.add("--dep-out-dir", dep_out_dir.path)
    args.add("--frontend-dist", frontend_dist.path)
    args.add("--out-dir", out.path)

    if ctx.attr.config:
        _run_tauri_tool_with_staged_config(
            ctx,
            tool = ctx.executable._tool,
            config = config,
            other_inputs = ctx.files.tauri_build_data + [frontend_dist] + dep_target_files,
            outputs = [out],
            args = args,
            mnemonic = "TauriAclPrep",
            progress_message = "Preparing Tauri ACL outputs for %s" % ctx.label.name,
        )
    else:
        inputs = depset(
            direct = ctx.files.cargo_srcs + ctx.files.tauri_build_data + [config, frontend_dist] + dep_target_files,
        )
        args.add("--config", config.path)

        ctx.actions.run(
            executable = ctx.executable._tool,
            inputs = inputs,
            outputs = [out],
            arguments = [args],
            mnemonic = "TauriAclPrep",
            progress_message = "Preparing Tauri ACL outputs for %s" % ctx.label.name,
        )

    return [DefaultInfo(files = depset([out]))]

tauri_acl_prep_dir = rule(
    implementation = _tauri_acl_prep_dir_impl,
    attrs = {
        "cargo_srcs": attr.label(mandatory = True),
        "config": attr.label(allow_single_file = True),
        "dep_env_targets": attr.label_list(),
        "frontend_dist": attr.label(mandatory = True),
        "tauri_build_data": attr.label(mandatory = True),
        "_tool": attr.label(
            default = Label("@rules_tauri//tools/tauri_acl_prep:tauri_acl_prep_exec"),
            cfg = "exec",
            executable = True,
        ),
    },
)

def _tauri_context_rust_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".rs")
    config = _single_output(ctx.attr.config, "config") if ctx.attr.config else _find_named_file(ctx.files.cargo_srcs, "tauri.conf.json", "cargo_srcs")
    embedded_assets_rust = _single_output(ctx.attr.embedded_assets_rust, "embedded_assets_rust")
    acl_out_dir = _single_output(ctx.attr.acl_out_dir, "acl_out_dir")
    inputs = depset(
        direct = ctx.files.cargo_srcs + ctx.files.tauri_build_data + [config, embedded_assets_rust, acl_out_dir],
    )

    args = ctx.actions.args()
    args.add("--config", config.path)
    args.add("--embedded-assets-rust", embedded_assets_rust.path)
    args.add("--acl-out-dir", acl_out_dir.path)
    args.add("--out", out.path)

    ctx.actions.run(
        executable = ctx.executable._tool,
        inputs = inputs,
        outputs = [out],
        arguments = [args],
        mnemonic = "TauriContextCodegen",
        progress_message = "Generating Tauri context for %s" % ctx.label.name,
    )

    return [DefaultInfo(files = depset([out]))]

tauri_context_rust = rule(
    implementation = _tauri_context_rust_impl,
    attrs = {
        "acl_out_dir": attr.label(mandatory = True),
        "cargo_srcs": attr.label(mandatory = True),
        "config": attr.label(allow_single_file = True),
        "embedded_assets_rust": attr.label(mandatory = True),
        "tauri_build_data": attr.label(mandatory = True),
        "_tool": attr.label(
            default = Label("@rules_tauri//tools/tauri_context_codegen:tauri_context_codegen_exec"),
            cfg = "exec",
            executable = True,
        ),
    },
)

def _tauri_context_support_dir_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    config = _single_output(ctx.attr.config, "config") if ctx.attr.config else _find_named_file(ctx.files.cargo_srcs, "tauri.conf.json", "cargo_srcs")
    embedded_assets_rust = _single_output(ctx.attr.embedded_assets_rust, "embedded_assets_rust")
    acl_out_dir = _single_output(ctx.attr.acl_out_dir, "acl_out_dir")

    args = ctx.actions.args()
    args.add("--embedded-assets-rust", embedded_assets_rust.path)
    args.add("--acl-out-dir", acl_out_dir.path)
    args.add("--out", out.path + "/full_context_rust.rs")

    if ctx.attr.config:
        _run_tauri_tool_with_staged_config(
            ctx,
            tool = ctx.executable._tool,
            config = config,
            other_inputs = ctx.files.tauri_build_data + [embedded_assets_rust, acl_out_dir],
            outputs = [out],
            args = args,
            mnemonic = "TauriContextCodegenDir",
            progress_message = "Generating Tauri context support dir for %s" % ctx.label.name,
        )
    else:
        inputs = depset(
            direct = ctx.files.cargo_srcs + ctx.files.tauri_build_data + [config, embedded_assets_rust, acl_out_dir],
        )
        args.add("--config", config.path)

        ctx.actions.run(
            executable = ctx.executable._tool,
            inputs = inputs,
            outputs = [out],
            arguments = [args],
            mnemonic = "TauriContextCodegenDir",
            progress_message = "Generating Tauri context support dir for %s" % ctx.label.name,
        )

    return [DefaultInfo(files = depset([out]))]

tauri_context_support_dir = rule(
    implementation = _tauri_context_support_dir_impl,
    attrs = {
        "acl_out_dir": attr.label(mandatory = True),
        "cargo_srcs": attr.label(mandatory = True),
        "config": attr.label(allow_single_file = True),
        "embedded_assets_rust": attr.label(mandatory = True),
        "tauri_build_data": attr.label(mandatory = True),
        "_tool": attr.label(
            default = Label("@rules_tauri//tools/tauri_context_codegen:tauri_context_codegen_exec"),
            cfg = "exec",
            executable = True,
        ),
    },
)

def _macos_dmg_impl(ctx):
    srcs = ctx.attr.app[DefaultInfo].files.to_list()
    app_candidates = [src for src in srcs if src.basename.endswith(".app")]
    if len(app_candidates) != 1:
        fail("app must provide exactly one .app directory, got %s" % [src.basename for src in srcs])

    app = app_candidates[0]
    output = ctx.actions.declare_file(ctx.attr.output_name)
    tool = ctx.file._tool

    args = ctx.actions.args()
    args.add("--app", app.path)
    args.add("--output", output.path)
    args.add("--volume-name", ctx.attr.volume_name)
    if ctx.file.volume_icon:
        args.add("--volume-icon", ctx.file.volume_icon.path)
    args.add("--window-pos", _format_window_coords("window_pos", ctx.attr.window_pos))
    args.add("--window-size", _format_window_coords("window_size", ctx.attr.window_size))
    if ctx.attr.icon_size:
        args.add("--icon-size", str(ctx.attr.icon_size))
    if ctx.attr.text_size:
        args.add("--text-size", str(ctx.attr.text_size))
    for name, coords in sorted(ctx.attr.icon_positions.items()):
        args.add("--icon-position", _parse_icon_position(name, coords))
    if ctx.attr.include_applications_link:
        args.add("--include-applications-link")

    ctx.actions.run_shell(
        inputs = depset(direct = [app, tool] + ([ctx.file.volume_icon] if ctx.file.volume_icon else [])),
        outputs = [output],
        command = """
set -euo pipefail
python3 "$@"
""",
        arguments = [tool.path, args],
        mnemonic = "KannaMacosDmg",
        progress_message = "Creating DMG for %s" % ctx.label.name,
        execution_requirements = {
            "local": "1",
            "no-sandbox": "1",
        },
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([output]))]

def _macos_codesign_app_impl(ctx):
    srcs = ctx.attr.app[DefaultInfo].files.to_list()
    app_candidates = [src for src in srcs if src.basename.endswith(".app")]
    if len(app_candidates) != 1:
        fail("app must provide exactly one .app directory, got %s" % [src.basename for src in srcs])

    app = app_candidates[0]
    out_dir = ctx.actions.declare_directory(ctx.attr.output_name)
    tool = ctx.file._tool

    args = ctx.actions.args()
    args.add("--app", app.path)
    args.add("--output", out_dir.path)
    args.add("--deployment-target-config", ctx.file.deployment_target_config.path)
    args.add("--deployment-target-tool", ctx.file._deployment_target_tool.path)
    if ctx.attr.signing_identity:
        args.add("--signing-identity", ctx.attr.signing_identity)

    ctx.actions.run_shell(
        inputs = depset(direct = [app, tool, ctx.file.deployment_target_config, ctx.file._deployment_target_tool]),
        outputs = [out_dir],
        command = """
set -euo pipefail
python3 "$@"
""",
        arguments = [tool.path, args],
        mnemonic = "KannaMacosCodesignApp",
        progress_message = "Codesigning app for %s" % ctx.label.name,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out_dir]))]

def _macos_updater_bundle_impl(ctx):
    srcs = ctx.attr.app[DefaultInfo].files.to_list()
    app_candidates = [src for src in srcs if src.basename.endswith(".app")]
    if len(app_candidates) != 1:
        fail("app must provide exactly one .app directory, got %s" % [src.basename for src in srcs])

    app = app_candidates[0]
    output = ctx.actions.declare_file(ctx.attr.output_name)

    ctx.actions.run_shell(
        inputs = depset(direct = [app]),
        outputs = [output],
        command = """
set -euo pipefail
app_path="$1"
output="$2"
app_name="$3"
stage_root="${TMPDIR:-/tmp}/kanna-updater-bundle.$$"
rm -rf "$stage_root"
trap 'rm -rf "$stage_root"' EXIT
mkdir -p "$stage_root"
cp -RL "$app_path" "$stage_root/$app_name"
find "$stage_root/$app_name" -type d -exec chmod 755 {} +
COPYFILE_DISABLE=1 tar -C "$stage_root" -czf "$output" "$app_name"
""",
        arguments = [app.path, output.path, app.basename],
        mnemonic = "KannaMacosUpdaterBundle",
        progress_message = "Creating updater bundle for %s" % ctx.label.name,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([output]))]

def _macos_codesign_file_impl(ctx):
    srcs = ctx.attr.src[DefaultInfo].files.to_list()
    if len(srcs) != 1:
        fail("src must provide exactly one file, got %s" % [src.basename for src in srcs])

    src = srcs[0]
    output = ctx.actions.declare_file(ctx.attr.output_name)
    tool = ctx.file._tool

    args = ctx.actions.args()
    args.add("--input", src.path)
    args.add("--output", output.path)
    if ctx.attr.signing_identity:
        args.add("--signing-identity", ctx.attr.signing_identity)

    ctx.actions.run_shell(
        inputs = depset(direct = [src, tool]),
        outputs = [output],
        command = """
set -euo pipefail
python3 "$@"
""",
        arguments = [tool.path, args],
        mnemonic = "KannaMacosCodesignFile",
        progress_message = "Codesigning file for %s" % ctx.label.name,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([output]))]

def _macos_notarize_dmg_impl(ctx):
    srcs = ctx.attr.dmg[DefaultInfo].files.to_list()
    if len(srcs) != 1:
        fail("dmg must provide exactly one file, got %s" % [src.basename for src in srcs])

    dmg = srcs[0]
    output = ctx.actions.declare_file(ctx.attr.output_name)
    tool = ctx.file._tool

    args = ctx.actions.args()
    args.add("--dmg", dmg.path)
    args.add("--output", output.path)

    ctx.actions.run_shell(
        inputs = depset(direct = [dmg, tool]),
        outputs = [output],
        command = """
set -euo pipefail
python3 "$@"
""",
        arguments = [tool.path, args],
        mnemonic = "KannaMacosNotarizeDmg",
        progress_message = "Notarizing DMG for %s" % ctx.label.name,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([output]))]

macos_dmg = rule(
    implementation = _macos_dmg_impl,
    attrs = {
        "app": attr.label(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "volume_name": attr.string(mandatory = True),
        "volume_icon": attr.label(allow_single_file = [".icns"]),
        "window_pos": attr.int_list(default = [10, 60]),
        "window_size": attr.int_list(default = [500, 350]),
        "icon_size": attr.int(default = 128),
        "text_size": attr.int(default = 16),
        "icon_positions": attr.string_dict(default = {}),
        "include_applications_link": attr.bool(default = True),
        "_tool": attr.label(
            allow_single_file = True,
            default = "//tools/bazel:build_macos_dmg.py",
        ),
    },
)

macos_codesign_app = rule(
    implementation = _macos_codesign_app_impl,
    attrs = {
        "app": attr.label(mandatory = True),
        "deployment_target_config": attr.label(
            allow_single_file = True,
            default = "//:.bazelrc",
        ),
        "output_name": attr.string(mandatory = True),
        "signing_identity": attr.string(),
        "_tool": attr.label(
            allow_single_file = True,
            default = "//tools/bazel:build_macos_signed_app.py",
        ),
        "_deployment_target_tool": attr.label(
            allow_single_file = True,
            default = "//tools/bazel:macos_deployment_target.py",
        ),
    },
)

macos_updater_bundle = rule(
    implementation = _macos_updater_bundle_impl,
    attrs = {
        "app": attr.label(mandatory = True),
        "output_name": attr.string(mandatory = True),
    },
)

macos_codesign_file = rule(
    implementation = _macos_codesign_file_impl,
    attrs = {
        "src": attr.label(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "signing_identity": attr.string(),
        "_tool": attr.label(
            allow_single_file = True,
            default = "//tools/bazel:build_macos_signed_file.py",
        ),
    },
)

macos_notarize_dmg = rule(
    implementation = _macos_notarize_dmg_impl,
    attrs = {
        "dmg": attr.label(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "_tool": attr.label(
            allow_single_file = True,
            default = "//tools/bazel:build_macos_notarized_dmg.py",
        ),
    },
)
