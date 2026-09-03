package com.uav.lowaltitude.modules.identity.infrastructure;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import com.uav.lowaltitude.modules.identity.domain.AppSession;

@Mapper
public interface SessionMapper {

    @Insert("""
            INSERT INTO app_session (session_id, user_id, expire_at, ip, shift_note)
            VALUES (#{sessionId}, #{userId}, #{expireAt}, #{ip}, #{shiftNote})
            """)
    int insert(AppSession session);

    @Select("""
            SELECT session_id AS sessionId, user_id AS userId, expire_at AS expireAt, ip, shift_note AS shiftNote
            FROM app_session WHERE session_id = #{sessionId}
            """)
    AppSession findById(@Param("sessionId") String sessionId);

    @Update("UPDATE app_session SET expire_at = 0 WHERE session_id = #{sessionId}")
    int expire(@Param("sessionId") String sessionId);
}
