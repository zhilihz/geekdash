FROM geekdash:app-V0.1.0-cc4a34b@sha256:5526899f8f1083ae792b369e4e002cd4d45f98a1b5a0d021a6595c3b8066e4e1 AS application
USER root
RUN find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name benchmarks -o -name examples -o -name .github \) -prune -exec rm -rf '{}' + \
 && find /app/node_modules -type f \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'CONTRIBUTING*' \) -delete \
 && rm -rf /app/node_modules/@types /app/node_modules/undici-types

FROM mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb AS database
RUN microdnf --disablerepo='*' remove -y mysql-shell microdnf libdnf librepo libsolv libmodulemd gpgme gnupg2 rpm rpm-libs \
 && rm -rf /var/cache/dnf /var/cache/yum /etc/yum.repos.d /usr/share/man /usr/share/info

# 从清理后的文件系统建立最终镜像，避免旧层继续携带已删除的软件。
FROM scratch
COPY --from=database / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=application /usr/local/bin/node /usr/local/bin/node
RUN node --version
COPY --from=application /app/ /app/
WORKDIR /app
COPY initialize.mjs container-entrypoint.sh ./
RUN chmod 755 /app/container-entrypoint.sh
ENV HOST=0.0.0.0 PORT=3000 GEEKDASH_DB_PROFILE=dev_app GEEKDASH_IMPORT_DIR=/var/lib/mysql/imports
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=12 CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/container-entrypoint.sh"]
