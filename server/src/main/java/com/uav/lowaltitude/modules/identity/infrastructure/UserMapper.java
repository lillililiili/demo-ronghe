package com.uav.lowaltitude.modules.identity.infrastructure;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import com.uav.lowaltitude.modules.identity.domain.AppUser;

@Mapper
public interface UserMapper {

    @Select("""
            SELECT user_id AS userId, account, name, role_code AS roleCode, status,
                   password_hash AS passwordHash, fail_count AS failCount, locked_until AS lockedUntil
            FROM app_user WHERE account = #{account}
            """)
    AppUser findByAccount(@Param("account") String account);

    @Select("""
            SELECT user_id AS userId, account, name, role_code AS roleCode, status,
                   password_hash AS passwordHash, fail_count AS failCount, locked_until AS lockedUntil
            FROM app_user WHERE user_id = #{userId}
            """)
    AppUser findById(@Param("userId") String userId);

    @Update("UPDATE app_user SET fail_count = #{failCount}, locked_until = #{lockedUntil} WHERE user_id = #{userId}")
    int updateLock(@Param("userId") String userId, @Param("failCount") int failCount, @Param("lockedUntil") Long lockedUntil);

    @Select("SELECT COUNT(*) FROM app_user")
    int count();
}
