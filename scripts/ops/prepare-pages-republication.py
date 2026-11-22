"""Verify and reuse a previously gated Pages artifact without rebuilding it."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

REPOSITORY = "sustynats/wirkungsoekonomie-produktiv"


def validate_source(run, jobs, artifacts, expected_sha):
    if (run.get("head_sha") != expected_sha
            or run.get("head_branch") != "main"
            or run.get("path") != ".github/workflows/deploy.yml"
            or run.get("status") != "completed"):
        raise ValueError("Source must be a completed production workflow for the exact main commit")
    for required in ("build", "release-assets"):
        matching = [job for job in jobs if job.get("name") == required]
        if len(matching) != 1 or matching[0].get("conclusion") != "success":
            raise ValueError(f"Source gate did not pass: {required}")
    matching = [a for a in artifacts if a.get("name") == "github-pages" and not a.get("expired")]
    if len(matching) != 1:
        raise ValueError("Exactly one unexpired github-pages artifact is required")
    artifact = matching[0]
    if (artifact.get("workflow_run", {}).get("head_sha") != expected_sha
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))):
        raise ValueError("Artifact provenance or immutable SHA-256 is unavailable")
    return artifact


def verify_archive(archive, artifact, destination):
    with archive.open("rb") as content:
        digest = "sha256:" + hashlib.file_digest(content, "sha256").hexdigest()
    if (archive.stat().st_size != artifact["size_in_bytes"]
            or digest != artifact["digest"]):
        raise ValueError("Downloaded artifact differs from GitHub's immutable digest")
    with zipfile.ZipFile(archive) as package:
        if package.namelist() != ["artifact.tar"]:
            raise ValueError("Unexpected Pages artifact container")
        package.extract("artifact.tar", destination)
    tar_path = destination / "artifact.tar"
    names = set()
    byte_count = 0
    with tarfile.open(tar_path) as pages:
        for member in pages:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe or linked Pages archive member")
            if member.isfile():
                if str(name) in names:
                    raise ValueError("Duplicate Pages archive member")
                names.add(str(name))
                byte_count += member.size
        if byte_count > 1024 ** 3 or not {"CNAME", "index.html"}.issubset(names):
            raise ValueError("Pages archive is oversized or incomplete")
        cname = next(m for m in pages.getmembers() if str(PurePosixPath(m.name)) == "CNAME")
        if pages.extractfile(cname).read().decode().strip() != "wirkungsoekonomie.de":
            raise ValueError("Pages domain differs from production")
    with tar_path.open("rb") as content:
        tar_sha = hashlib.file_digest(content, "sha256").hexdigest()
    return {"tarSha256": tar_sha, "publicFiles": len(names), "publicBytes": byte_count}


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["SOURCE_RUN"]
    source_sha = os.environ["SOURCE_COMMIT"]
    if repo != REPOSITORY or not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("Invalid production repository, run or commit")
    def api(route):
        return json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/{route}"]))
    run = api(f"actions/runs/{run_id}")
    jobs = api(f"actions/runs/{run_id}/jobs?per_page=100")["jobs"]
    artifacts = api(f"actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
    artifact = validate_source(run, jobs, artifacts, source_sha)
    comparison = api(f"compare/{source_sha}...{os.environ['GITHUB_SHA']}")
    if comparison.get("status") not in ("ahead", "identical"):
        raise ValueError("Reviewed source is not an ancestor of this production workflow")
    destination = Path(os.environ["RUNNER_TEMP"]) / "verified-pages-republication"
    destination.mkdir()
    archive = destination / "download.zip"
    with archive.open("wb") as output:
        subprocess.run(["gh", "api", f"repos/{repo}/actions/artifacts/{artifact['id']}/zip"], stdout=output, check=True)
    proof = verify_archive(archive, artifact, destination)
    archive.unlink()
    proof.update(repository=repo, sourceRun=int(run_id), sourceCommit=source_sha,
                 artifactId=artifact["id"], artifactDigest=artifact["digest"],
                 workflowCommit=os.environ["GITHUB_SHA"], rebuilt=False)
    (destination / "provenance.json").write_text(json.dumps(proof, indent=2) + "\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write("### Verified Pages republication\n\nNo rebuild or content modification.\n\n```json\n" + json.dumps(proof, indent=2) + "\n```\n")
    print(json.dumps(proof))


if __name__ == "__main__":
    main()
