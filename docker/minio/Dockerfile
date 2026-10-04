# The community release is distributed as source; pin the local S3 test server.
FROM golang:1.24.8-alpine AS build
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOMAXPROCS=2
RUN go install -p 2 github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -S minio && adduser -S -G minio minio && mkdir /data && chown minio:minio /data
COPY --from=build /go/bin/minio /usr/local/bin/minio
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
