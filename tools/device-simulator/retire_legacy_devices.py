#!/usr/bin/env python3
"""Retire the per-batch devices registered by simulator versions before 2026-10-05.

Old versions registered a new device set for every batch (device numbers such as
sim-1004093015-a1b2-3). After a batch those devices never report again, stay
"heartbeat timeout" and keep their HIGH device incidents open. This tool lists
them and, only with --apply, disables and then deletes each one through the
normal device API, so authorization, version checks and audit stay in place.
Stable map-sim-* devices and devices entered by people are never touched.
"""
import argparse
import getpass
import os
import sys

from platform_client import Platform


def main(argv=None):
    parser = argparse.ArgumentParser(description='清理旧版模拟器按批次登记、已不再上报的设备（默认只列出）')
    parser.add_argument('--api', default='http://127.0.0.1:8081/api/v1', help='系统 API 地址，仅限本机')
    parser.add_argument('--account', required=True, help='有设备运维权限的系统账号')
    parser.add_argument('--apply', action='store_true', help='逐台停用并删除；不加时只列出，不改数据')
    args = parser.parse_args(argv)
    try:
        platform = Platform(args.api)
        password = os.environ.get('SIM_PLATFORM_PASSWORD') or getpass.getpass('系统密码：')
        platform.login(args.account, password)
        result = platform.retire_legacy_batch_devices(apply=args.apply)
    except ValueError as error:
        print('未完成：' + str(error), file=sys.stderr)
        return 2
    for item in result['found']:
        print(f"{item['device_no']}\t{item.get('name') or ''}\t{'已启用' if item.get('enabled') else '已停用'}")
    if not args.apply:
        print(f"共 {len(result['found'])} 台旧批次模拟设备；确认后加 --apply 停用并删除。")
        return 0
    for item in result['failed']:
        print(f"未处理 {item['device_no']}：{item['error']}", file=sys.stderr)
    print(f"已停用并删除 {len(result['retired'])} 台，未处理 {len(result['failed'])} 台。")
    return 1 if result['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())
