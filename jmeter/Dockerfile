FROM eclipse-temurin:17-jre-jammy

ARG JMETER_VERSION=5.6.3

WORKDIR /opt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" \
       -o /tmp/jmeter.tgz \
    && tar -xzf /tmp/jmeter.tgz -C /opt \
    && rm /tmp/jmeter.tgz \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/apache-jmeter-${JMETER_VERSION}/bin:${PATH}"

ENTRYPOINT ["jmeter"]