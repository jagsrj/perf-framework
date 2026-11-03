FROM eclipse-temurin:25-jre-jammy

ARG JMETER_VERSION=5.6.3
# SHA-512 of apache-jmeter-${JMETER_VERSION}.tgz as published by Apache
# (https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-5.6.3.tgz.sha512).
# Update it together with JMETER_VERSION; the build fails if the download does not match.
ARG JMETER_SHA512=5978a1a35edb5a7d428e270564ff49d2b1b257a65e17a759d259a9283fc17093e522fe46f474a043864aea6910683486340706d745fcdf3db1505fd71e689083

WORKDIR /opt

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" \
      -o /tmp/jmeter.tgz; \
    echo "${JMETER_SHA512}  /tmp/jmeter.tgz" | sha512sum --check --strict -; \
    tar -xzf /tmp/jmeter.tgz -C /opt; \
    rm /tmp/jmeter.tgz; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 1000 jmeter; \
    useradd --system --uid 1000 --gid jmeter --home-dir /home/jmeter --create-home jmeter

ENV PATH="/opt/apache-jmeter-${JMETER_VERSION}/bin:${PATH}" \
    HOME=/home/jmeter

# Run as an unprivileged user. On Linux the web app also passes --user <its own uid:gid>
# so the container can write to the bind-mounted results directory.
USER jmeter
WORKDIR /home/jmeter

ENTRYPOINT ["jmeter"]
