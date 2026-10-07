"""Windows scheduled monitor; fresh daily prices, partial retry, nonblocking failure popup."""
import argparse
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import uuid
from history import archive, SCENARIO

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
def save(path, data):
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def popup(message, seconds=120):
    if os.name != "nt":
        return
    import base64
    # Separate process: dismissing the message is not required for task failure/retry.
    quoted = message.replace("'", "''")
    command = "$w=New-Object -ComObject WScript.Shell; $null=$w.Popup('" + quoted + "'," + str(seconds) + ", 'Vooglam 配镜监测', 48)"
    encoded = base64.b64encode(command.encode("utf-16le")).decode()
    with (ROOT / "popup.log").open("a", encoding="utf-8") as stream:
        return subprocess.Popen(["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
                         creationflags=subprocess.CREATE_NO_WINDOW, stdout=stream, stderr=stream)


def command_run(command, cwd, log, timeout, env):
    with log.open("a", encoding="utf-8") as stream:
        stream.write("COMMAND " + repr(command) + "\n")
        stream.flush()
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=stream, stderr=stream, creationflags=subprocess.CREATE_NO_WINDOW)
            if process.poll() is None:
                process.kill()
            process.wait(timeout=30)
            raise RuntimeError("采集超时，已终止该次采集进程；详见 " + str(log))
        if code:
            raise RuntimeError("采集进程失败（退出码 " + str(code) + "）；详见 " + str(log))


def collect(config, target, state, smoke=False):
    scripts = target
    scripts.mkdir(exist_ok=True)
    for filename in ("vooglam_lens_tree.py", "vooglam_product_probe.py", "vooglam_incremental_batch.py",
                     "vooglam_five_product_report.py"):
        shutil.copy2(PROJECT / filename, scripts / filename)
    products = config["products"][:1] if smoke else config["products"]
    urls = scripts / "urls.json"
    save(urls, [p["url"] for p in products])
    # The packaged report reads this input at import time.
    save(scripts / "vooglam_five_urls.json", [p["url"] for p in products])
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    channel = config.get("browser_channel", "chrome")
    command_run([sys.executable, "-u", str(scripts / "vooglam_product_probe.py"), "--urls", str(urls), "--channel", channel],
                scripts, target / "identity.log", config["identity_timeout_seconds"], env)
    failures, rows = [], []
    # Report helpers validate cart identity, arithmetic and original evidence.
    import importlib.util
    spec = importlib.util.spec_from_file_location("monitor_report", scripts / "vooglam_five_product_report.py")
    report = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(report)
    for product in products:
        pid = product["product_id"]
        master_path = scripts / "vooglam_products" / pid / "vooglam_lens_tree_master.json"
        master = json.loads(master_path.read_text(encoding="utf-8"))
        identity = master["product_identity"]
        if identity.get("status") != "observed":
            failures.append(pid + "：商品页服务不可达或页面未就绪，请检查网络/代理；" + identity.get("error", "未知原因"))
            continue
        if identity.get("name") != product["name"] or identity.get("product_code") != product["sku"]:
            failures.append(pid + "：商品身份或默认配色发生变化，需人工核对")
            continue
        if identity.get("scope_status") != "in_scope" or identity.get("purchase_mode") != "select_lenses":
            failures.append(pid + "：不支持当前商品类型/配镜流程")
            continue
        jobs = product["jobs"][:1] if smoke else product["jobs"]
        seed = scripts / (pid + "_seeds.json")
        save(seed, jobs)
        try:
            command_run([sys.executable, "-u", str(scripts / "vooglam_incremental_batch.py"),
                         "--url", product["url"], "--seed-file", str(seed), "--max-paths", str(len(jobs)),
                         "--no-expand", "--channel", channel], scripts, target / (pid + "_collection.log"),
                        min(120, config["product_timeout_seconds"]) if smoke else config["product_timeout_seconds"], env)
        except Exception as exc:
            failures.append(pid + "：" + str(exc))
        master = json.loads(master_path.read_text(encoding="utf-8"))
        product_rows = report.verified_rows(master, identity)
        for row in product_rows:
            # Store absolute durable paths, independent of generated report location.
            from urllib.parse import unquote
            row["evidence"] = str(report.OUT / unquote(row["evidence"])) if row.get("evidence") else None
            row["evidence_text"] = str(report.OUT / unquote(row["evidence_text"])) if row.get("evidence_text") else None
        rows += product_rows
        if len(product_rows) != len(jobs):
            failures.append(pid + "：购物车核价覆盖 " + str(len(product_rows)) + "/" + str(len(jobs)) + "，未完成配置将在下次重试")
    save(target / "prices.json", {"observed_rows": rows, "failures": failures, "scenario": SCENARIO})
    comparisons = archive(ROOT / "history.sqlite3", rows, SCENARIO, target.name)
    save(target / "comparisons.json", comparisons)
    state.update(verified_configurations=len(rows), changes=sum(c.get("status") == "ok" and c.get("difference") != "0.00" and float(c["difference"]) != 0 for c in comparisons),
                 failures=failures)
    if failures:
        raise RuntimeError("；".join(failures))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--smoke", action="store_true", help="One configuration of first product; separate run")
    parser.add_argument("--simulate-failure", action="store_true", help="Offline failure handling test")
    parser.add_argument("--no-popup", action="store_true")
    parser.add_argument("--popup-test", action="store_true")
    args = parser.parse_args()
    if args.popup_test:
        process = popup("这是配镜监测的测试弹窗。实际失败时会提示原因，30 分钟后由任务计划程序重试。", 15)
        return process.wait(timeout=30) if process else 0
    config = json.loads(args.config.read_text(encoding="utf-8"))
    # Keep evidence paths close to the original length on Windows.
    runs = PROJECT.parent / "assets" / "m"
    runs.mkdir(exist_ok=True)
    token = datetime.now().strftime("%Y%m%d")
    if args.smoke or args.simulate_failure:
        token += "_test_" + uuid.uuid4().hex[:8]
    target = runs / token
    target.mkdir(exist_ok=True)
    # Kernel-held file lock is released after process termination, including timeouts.
    lock = (ROOT / "monitor.lock").open("a+")
    if os.name == "nt":
        import msvcrt
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return 0
    state_file = target / "status.json"
    prior = json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
    state = {"run_id": token, "started_at": datetime.now().astimezone().isoformat(),
             "attempt": prior.get("attempt", 0) + 1, "status": "running", "scope": "fixed_verified_configs"}
    save(state_file, state)
    if not (args.smoke or args.simulate_failure):
        save(ROOT / "latest_status.json", state)
    try:
        if args.simulate_failure:
            raise RuntimeError("网络服务不可达（离线测试，不代表真实网络故障）")
        collect(config, target, state, args.smoke)
        state.update(status="success", last_success_at=datetime.now().astimezone().isoformat())
        code = 0
    except Exception as exc:
        state.update(status="failed", error=str(exc),
                     retry_not_before=(datetime.now().astimezone()+timedelta(minutes=config["retry_minutes"])).isoformat())
        error_log = target / ("error_attempt_" + str(state["attempt"]) + ".log")
        error_log.write_text(traceback.format_exc(), encoding="utf-8")
        state["error_log"] = str(error_log)
        if not args.no_popup:
            try:
                popup("配镜监测失败：" + str(exc)[:700] + "\n请检查网络/代理或日志。失败后 "
                      + str(config["retry_minutes"]) + " 分钟重试，最多 " + str(config["retry_count"])
                      + " 次。\n日志：" + str(target))
            except Exception as popup_error:
                state["popup_error"] = str(popup_error)
        code = 1
    finally:
        state["finished_at"] = datetime.now().astimezone().isoformat()
        save(target / ("attempt_" + str(state["attempt"]) + ".json"), state)
        save(state_file, state)
        if not (args.smoke or args.simulate_failure):
            save(ROOT / "latest_status.json", state)
        lock.close()
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        (ROOT / "startup_error.log").write_text(traceback.format_exc(), encoding="utf-8")
        try:
            popup("配镜监测启动失败：" + str(exc) + "\n日志：" + str(ROOT / "startup_error.log"))
        except Exception:
            pass
        sys.exit(1)
