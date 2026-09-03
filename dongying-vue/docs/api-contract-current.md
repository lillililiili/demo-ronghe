# 当期前后端 API 契约

本清单只记录后端当前已经存在的接口。响应统一使用 `{ ok, data, error }`；除登录外，认证接口通过 `Authorization: Bearer <session_id>` 携带会话。

| 方法 | 路径 | 谁用 | 状态 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 登录页 | 本刀接通 |
| POST | `/api/v1/auth/logout` | 退出 | 本刀接通 |
| GET | `/api/v1/auth/me` | 恢复会话 | 本刀接通 |
| GET | `/api/v1/alarms` | 尚未切页 | 空分页占位 |
| GET | `/api/v1/devices` | 尚未切页 | 空分页占位 |

用户/角色 CRUD 接口尚未由协作者 A 提供，前端不得虚构；用户管理、角色管理与权限矩阵当前仍使用既有 Mock 数据，等待后续 RBAC 接口切换。
