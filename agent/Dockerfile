# perf-framework load generator agent: JMeter plus the agent, in one image.
#
# Build the JMeter image first, then this one (from the repository root):
#   docker build -t perf-framework-jmeter:5.6.3 ./jmeter
#   docker build -t perf-framework-agent:1.0.0 ./agent
ARG JMETER_IMAGE=perf-framework-jmeter:5.6.3

FROM node:26-bookworm-slim AS agent
WORKDIR /agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY agent.js ./

FROM ${JMETER_IMAGE}
# The official Node.js binary is built against an old glibc and runs on the JMeter base image.
COPY --from=agent /usr/local/bin/node /usr/local/bin/node
COPY --from=agent --chown=jmeter:jmeter /agent /opt/perf-agent

ENV PERF_AGENT_WORKDIR=/home/jmeter/agent-work \
    JMETER_BIN=jmeter
RUN mkdir -p /home/jmeter/agent-work
VOLUME /home/jmeter/agent-work

USER jmeter
WORKDIR /home/jmeter
ENTRYPOINT ["node", "/opt/perf-agent/agent.js"]
