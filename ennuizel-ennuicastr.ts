/// <reference path="../ennuizel.d.ts" />

const licenseInfo = `
Copyright (c) 2019-2021 Yahweasel

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

// extern
declare let LibAV: any;

const ui = Ennuizel.ui;
const hotkeys = Ennuizel.hotkeys;

// The plugin info
const plugin: ennuizel.Plugin = {
    name: "Ennuicastr",
    id: "ennuicastr",
    infoURL: "https://github.com/Yahweasel/ennuizel-ennuicastr-plugin",
    description: "This plugin connects Ennuizel (the audio editing tool) to Ennuicastr (the online recording tool).",
    licenseInfo
};

// Check whether to use the wizard
(function() {
    const url = new URL(document.location.href);
    if (url.searchParams.get("i"))
        plugin.wizard = wizard;
})();

// Register the plugin
Ennuizel.registerPlugin(plugin);

/**
 * The Ennuicastr wizard.
 */
async function wizard(d: ennuizel.ui.Dialog) {
    // Get project info
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const idS = params.get("i");
    const id = Number.parseInt(idS, 36);
    const keyS = params.get("k");
    const key = Number.parseInt(keyS, 36);
    let projName = params.get("nm");
    if (!projName) projName = idS;

    // Hide it from the URL
    url.search = "";
    window.history.pushState({}, "Ennuizel — " + projName, url.toString());
    document.title = "Ennuizel — " + projName;

    // Check for existing projects
    {
        const projects = await Ennuizel.getProjects();
        const ecProjects: string[] = [];
        for (const project of projects) {
            if (/^ec-/.test(project.name))
                ecProjects.push(project.id);
        }

        if (ecProjects.length) {
            let doDelete = await ui.dialog(async function(d, show) {
                ui.mk("div", d.box, {
                    innerHTML: "You have data cached in your browser from previous projects. Would you like to delete it to save space? This will <em>not</em> delete your recordings from the server.<br/><br/>"
                });

                const yes = hotkeys.btn(d, "_Yes, delete it", {className: "row"});
                const no = hotkeys.btn(d, "_No, keep it", {className: "row"});

                show(no);

                return await new Promise(res => {
                    yes.onclick = () => res(true);
                    no.onclick = () => res(false);
                });
            });

            if (doDelete) {
                // Delete them
                for (const id of ecProjects)
                    await Ennuizel.deleteProjectById(id);
            }
        }
    }

    // Now ask them whether to wizard
    let doWizard: boolean = false;
    let doCancel: boolean = false;
    await ui.dialog(async function(d, show) {
        ui.mk("div", d.box, {
            innerHTML: "This tool is capable of automatically performing some mastering tasks on your audio and exporting it. Alternatively, you may use this tool manually to edit your audio.<br/><br/>"
        });

        const auto = hotkeys.btn(d, "_Automatic Mastering", {className: "row"});
        const manual = hotkeys.btn(d, "Manual _Editing", {className: "row"});
        const canc = hotkeys.btn(d, "_Cancel", {className: "row"});

        show(auto);

        await new Promise(res => {
            auto.onclick = () => {
                doWizard = true;
                res(null);
            };
            manual.onclick = () => res(null);
            canc.onclick = () => {
                doCancel = true;
                res(null);
            };
        });
    });

    if (doCancel)
        return;

    // If they chose the wizard, figure out what tasks to perform
    let opts = {
        format: "",
        mix: false,
        level: false,
        noiser: false,
        keep: false
    };
    if (doWizard) {
        await ui.dialog(async function(d, show) {
            // Format selection
            hotkeys.mk(d, "_Format:&nbsp;",
                lbl => ui.lbl(d.box, "ec-format", lbl, {className: "ez"}));
            const fsel = ui.mk("select", d.box, {
                id: "ec-format"
            });
            for (const format of Ennuizel.standardExports) {
                ui.mk("option", fsel, {
                    value: format.name,
                    innerText: format.name.replace("_", "")
                });
            }
            ui.mk("br", d.box);
            ui.mk("br", d.box);

            // Options
            function mkOption(id: string, lbl: string) {
                const ret = ui.mk("input", d.box, {
                    id: "ec-" + id,
                    type: "checkbox"
                });
                hotkeys.mk(d, "&nbsp;" + lbl,
                    lbl => ui.lbl(d.box, "ec-" + id, lbl));
                ui.mk("br", d.box);
                return ret;
            }

            const mix = mkOption("mix", "_Mix into a single track");
            const level = mkOption("level", "_Level volume");
            level.checked = true;
            const noiser = mkOption("noiser", "_Noise reduction");
            const keep = mkOption("keep", "_Keep data cached in browser");
            ui.mk("br", d.box);

            const go = hotkeys.btn(d, "_Go", {className: "row"});
            const canc = hotkeys.btn(d, "_Cancel", {className: "row"});
            show(go);

            doWizard = await new Promise(res => {
                go.onclick = () => {
                    opts.format = fsel.value;
                    opts.mix = mix.checked;
                    opts.level = level.checked;
                    opts.noiser = noiser.checked;
                    opts.keep = keep.checked;
                    res(true);
                };

                canc.onclick = () => res(false);
            });
        });
    }

    // Import the actual data
    const project = await loadData(d, url, id, key, projName);

    // If they didn't want the wizard, we're now done
    if (!doWizard)
        return;

    d.box.innerHTML = "Loading...";

    // Disable undo for all the wizard tasks
    await Ennuizel.disableUndo();

    const nr = Ennuizel.getPlugin("noise-repellent");
    const l = Ennuizel.getPlugin("better-normalization");

    // Make our pre-filter
    let preFilter:
        (x: ennuizel.EZStream<ennuizel.LibAVFrame>) =>
        Promise<ReadableStream<ennuizel.LibAVFrame>> = null;
    if (opts.noiser || opts.level) {
        preFilter = async function(x) {
            let y: ReadableStream<ennuizel.LibAVFrame> = null;
            if (opts.noiser)
                y = await nr.api.noiseRepellent(x, {WHITENING: 50});
            if (opts.level)
                y = await l.api.betterNormalize(
                    y ? new Ennuizel.EZStream(y) : x);
            return y;
        };
    }

    // Mixing
    if (opts.mix) {
        // Maybe make our post-filter
        let postFilter:
            (x: ennuizel.EZStream<ennuizel.LibAVFrame>) =>
            Promise<ReadableStream<ennuizel.LibAVFrame>> = null;
        if (opts.level)
            postFilter = l.api.betterNormalize;

        // Perform the mix
        Ennuizel.select.selectAll();
        const sel = Ennuizel.select.getSelection();
        await project.addTrack(
            await Ennuizel.filters.mixTracks(sel, d, {preFilter, postFilter}));

        // Get rid of the now-mixed tracks
        d.box.innerHTML = "Loading...";
        for (const track of sel.tracks)
            await project.removeTrack(track);

    } else {
        // No mixing, just apply the filters we have
        if (preFilter) {
            Ennuizel.select.selectAll();
            const sel = Ennuizel.select.getSelection();
            await Ennuizel.filters.selectionFilter(preFilter, false, sel, d);
        }

    }

    // Export
    {
        // Get the export options
        const exportt = Ennuizel.standardExports
            .filter(x => x.name === opts.format)[0].options;

        // And export
        Ennuizel.select.selectAll();
        await Ennuizel.exportAudio(Object.assign({
            prefix: projName
        }, exportt), Ennuizel.select.getSelection(), d);
        await Ennuizel.exportCaption({prefix: projName},
            Ennuizel.select.getSelection(), d);
    }

    d.box.innerHTML = "Loading...";

    // Delete it
    if (!opts.keep)
        await project.del();

    await ui.alert("Your audio has now been exported. You may close this tab, or click OK to continue using this tool.");
}

/**
 * Load remote data.
 */
async function loadData(
    d: ennuizel.ui.Dialog, url: URL, id: number, key: number, projName: string
) {
    // Make the project
    const project = await Ennuizel.newProject("ec-" + projName + "-" +
        id.toString(36));

    // Get the info
    const response = await fetch("/rec.jss?i=" + id.toString(36) + "&k=" +
        key.toString(36) + "&f=info");
    const info = await response.json();
    const transcription = info.info.transcription;

    // Create the tracks
    const tracks: {idx: number, track: ennuizel.track.AudioTrack}[] = [];
    const capTracks: {idx: number, track: ennuizel.captions.CaptionTrack}[] = [];
    const sfxTracks: {idx: number, track: ennuizel.track.AudioTrack}[] = [];
    for (let idx = 1; info.tracks[idx]; idx++) {
        const track = await project.newAudioTrack(
            {name: idx + "-" + info.tracks[idx].nick});
        tracks.push({idx, track});

        if (transcription) {
            const ctrack = await project.newCaptionTrack(
                {name: idx + "-" + info.tracks[idx].nick});
            capTracks.push({idx, track: ctrack});
        }
    }
    const trackCt = tracks.length;
    for (let idx = 1; idx <= info.sfx; idx++) {
        const track = await project.newAudioTrack(
            {name: "SFX-" + idx});
        sfxTracks.push({idx, track});
    }

    // Status info
    const status: {
        name: string,
        duration: number|boolean
    }[] = [];
    for (const track of tracks)
        status.push({name: track.track.name, duration: false});
    for (const track of sfxTracks)
        status.push({name: track.track.name, duration: false});

    // Show the current status
    function showStatus() {
        let str = "Loading...<br/>" +
            status.map(x => {
                let s = x.name + ": ";
                if (x.duration === false) {
                    s += "Not yet loading";
                } else if (x.duration === true) {
                    s += "Finished loading";
                } else {
                    s += Ennuizel.util.timestamp(x.duration);
                }
                return s;
            }).join("<br/>");
        d.box.innerHTML = str;
    }

    // Function to load a track
    async function loadTrack(
        track: ennuizel.track.AudioTrack, cmd: number, idx: number,
        sidx: number
    ) {
        // Make a libav instance
        const libav = await LibAV.LibAV();

        // Make the connection
        const sock = new WebSocket("wss://" + url.host + "/ws");
        sock.binaryType = "arraybuffer";

        // Receive data
        let first = true;
        const incoming: ArrayBuffer[] = [];
        let incomingRes: (x:unknown) => void = null;
        sock.onmessage = ev => {
            if (first) {
                /* First message is an acknowledgement. FIXME: Actually check
                 * it! */
                first = false;
                return;
            }

            // Accept the data
            incoming.push(ev.data);

            // And inform the reader
            if (incomingRes)
                incomingRes(null);
        };

        // Log in
        sock.onopen = () => {
            const buf = new DataView(new ArrayBuffer(16));
            buf.setUint32(0, cmd, true);
            buf.setUint32(4, id, true);
            buf.setUint32(8, key, true);
            buf.setUint32(12, idx, true);
            sock.send(buf);
        };

        // Reader for incoming data
        const inStream = new Ennuizel.ReadableStream({
            async pull(controller) {
                while (true) {
                    if (incoming.length) {
                        // Get the part
                        const part = incoming.shift();
                        const partD = new DataView(part);

                        // Ack it
                        const ack = new DataView(new ArrayBuffer(8));
                        ack.setUint32(4, partD.getUint32(0, true), true);
                        sock.send(ack);

                        // And enqueue it
                        if (part.byteLength > 4) {
                            controller.enqueue(new Uint8Array(part).slice(4));
                        } else {
                            controller.close();
                            sock.close();
                        }

                        break;
                    }

                    // No incoming data, so wait for more
                    await new Promise(res => incomingRes = res);
                    incomingRes = null;
                }
            }
        });
        const inRdr = inStream.getReader();

        // Get 1MB of data to queue up libav
        await libav.mkreaderdev("tmp.ogg");
        {
            let remaining = 1024*1024;
            while (remaining > 0) {
                const rd = await inRdr.read();
                if (rd.done)
                    break;
                await libav.ff_reader_dev_send("tmp.ogg", rd.value);
                remaining -= rd.value.length;
            }
        }

        // Prepare to decode
        const [fmt_ctx, [stream]] =
            await libav.ff_init_demuxer_file("tmp.ogg");
        const [, c, pkt, frame] =
            await libav.ff_init_decoder(stream.codec_id, stream.codecpar);

        // We also need to change the format
        let buffersrc_ctx: number = -1, buffersink_ctx: number = 1;

        // Readable stream for the track
        const trackStream = new Ennuizel.ReadableStream({
            async pull(controller) {
                // Decode
                while (true) {
                    // Get a bit
                    const rd = await inRdr.read();
                    await libav.ff_reader_dev_send("tmp.ogg",
                        rd.done ? null : rd.value);

                    // Read it
                    const [, packets] =
                        await libav.ff_read_multi(fmt_ctx, pkt, "tmp.ogg");
                    if (!packets[stream.index])
                        continue;

                    // Decode it
                    const frames =
                        await libav.ff_decode_multi(c, pkt, frame,
                            packets[stream.index], rd.done);

                    // Prepare the filter
                    if (frames.length && buffersrc_ctx < 0) {
                        // Make the filter
                        const toFormat = Ennuizel.fromPlanar(frames[0].format);
                        track.format = toFormat;
                        track.sampleRate = frames[0].sample_rate;
                        track.channels = frames[0].channels;
                        const channelLayout = (track.channels === 1) ? 4 : ((1<<track.channels)-1);

                        [, buffersrc_ctx, buffersink_ctx] =
                            await libav.ff_init_filter_graph("anull", {
                                sample_rate: track.sampleRate,
                                sample_fmt: frames[0].format,
                                channel_layout: channelLayout
                            }, {
                                sample_rate: track.sampleRate,
                                sample_fmt: toFormat,
                                channel_layout: channelLayout
                            });
                    }

                    if (buffersrc_ctx >= 0) {
                        // Filter it
                        const fframes =
                            await libav.ff_filter_multi(buffersrc_ctx, buffersink_ctx,
                                frame, frames, rd.done);

                        // And send it along
                        if (status[sidx].duration === false)
                            status[sidx].duration = 0;
                        for (const frame of fframes) {
                            controller.enqueue(frame);
                            (<number> status[sidx].duration) +=
                                frame.nb_samples / track.sampleRate;
                        }
                        if (rd.done)
                            status[sidx].duration = true;
                        showStatus();

                        if (fframes.length && !rd.done)
                            break;
                    }

                    if (rd.done) {
                        controller.close();
                        break;
                    }
                }
            }
        });

        // And append
        await track.append(new Ennuizel.EZStream(trackStream));

        libav.terminate();
    }

    // # of threads
    const threads = Math.min(
        navigator.hardwareConcurrency || 1,
        8
    );
    const promises: Promise<unknown>[] = [];

    // Run them all
    while (tracks.length + sfxTracks.length) {
        // Enqueue normal tracks
        while (tracks.length && promises.length < threads) {
            const track = tracks.shift();
            promises.push(loadTrack(track.track, 0x11, track.idx, track.idx - 1));
        }

        // Enqueue SFX tracks
        while (sfxTracks.length && promises.length < threads) {
            const track = sfxTracks.shift();
            promises.push(loadTrack(track.track, 0x12, track.idx, trackCt + track.idx));
        }

        // Wait for one to finish
        const idx = await Promise.race(promises.map((x, idx) => x.then(() => idx)));
        promises.splice(idx, 1);
    }

    // Wait for them all to finish
    await Promise.all(promises);

    // Load any caption tracks
    d.box.innerHTML = "Loading...";
    for (const {idx, track} of capTracks) {
        const response = await fetch("/rec.jss?i=" + id.toString(36) + "&k=" +
            key.toString(36) + "&f=vosk&t=" + idx);
        let caps: any[] = [];
        try {
            caps = await response.json();
        } catch (ex) {}
        caps = caps.filter(x => x.length > 0);

        // Add all the captions
        for (let lo = 0; lo < caps.length; lo += 16) {
            const lines = caps.slice(lo, lo + 16);
            d.box.innerHTML = "Loading captions...<br/>" + track.name + ": " +
                Ennuizel.util.timestamp(lines[0][0].start);
            await track.appendRaw(lines);
        }
    }
    d.box.innerHTML = "Loading...";

    return project;
}
